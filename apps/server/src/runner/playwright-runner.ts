import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExecutionEvidence, RunnerOutput } from "@failspec/contracts";
import type { RunnerAdapter, RunnerInput } from "@failspec/core";
import {
  appendDependencyInstallLog,
  buildStartCommand,
  buildTestCommand,
  createRunnerCommandPolicy,
  planDependencyInstall,
  recordDependencyInstall,
  type NpmCommand,
  type RepositoryCommandPolicy
} from "../repository/preflight.js";
import { stagedGeneratedTestPath } from "./staging.js";

export const runnerOutputDirectory = ".failspec/runner";
const startupTimeoutMs = 30_000;
const testTimeoutMs = 60_000;
const readinessIntervalMs = 250;
const maximumProcessOutputBytes = 256 * 1024;
const maximumEvidenceTextLength = 2_000;

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunningCommand {
  stop(): Promise<void>;
}

export interface RunnerOperations {
  createPolicy: typeof createRunnerCommandPolicy;
  planInstall: typeof planDependencyInstall;
  appendInstallLog: typeof appendDependencyInstallLog;
  recordInstall: typeof recordDependencyInstall;
  allocatePort(): Promise<number>;
  waitForReady(url: string): Promise<boolean>;
  run(command: NpmCommand, options: CommandOptions): Promise<CommandResult>;
  start(command: NpmCommand, options: CommandOptions): Promise<RunningCommand>;
}

interface CommandOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  logPath?: string;
}

const defaultOperations: RunnerOperations = {
  createPolicy: createRunnerCommandPolicy,
  planInstall: planDependencyInstall,
  appendInstallLog: appendDependencyInstallLog,
  recordInstall: recordDependencyInstall,
  allocatePort,
  waitForReady,
  run: runCommand,
  start: startCommand
};

export class PlaywrightRunnerAdapter implements RunnerAdapter {
  constructor(private readonly operations: RunnerOperations = defaultOperations) {}

  async run(input: RunnerInput): Promise<RunnerOutput> {
    const startedAt = Date.now();
    try {
      return await this.execute(input, startedAt);
    } catch {
      return unavailableOutput(startedAt);
    }
  }

  private async execute(input: RunnerInput, startedAt: number): Promise<RunnerOutput> {
    const worktreePath = await stagedTestWorktree(input.repositoryPath, input.generatedTest.path);
    if (!worktreePath) {
      return unavailableOutput(startedAt);
    }

    const policyResult = await this.operations.createPolicy(worktreePath);
    if (policyResult.status !== "ready") {
      return unavailableOutput(startedAt);
    }
    const output = await runnerPaths(worktreePath);
    if (!output) {
      return unavailableOutput(startedAt);
    }

    const environment = runnerEnvironment();
    const install = await this.operations.planInstall(worktreePath);
    if (install.kind === "unavailable") {
      return unavailableOutput(startedAt);
    }
    if (install.kind === "install") {
      const result = await this.operations.run(install.command, {
        cwd: worktreePath,
        env: environment,
        timeoutMs: testTimeoutMs
      });
      await this.operations.appendInstallLog(worktreePath, `${result.stdout}${result.stderr}`);
      if (result.exitCode !== 0 || result.timedOut || (await this.operations.recordInstall(worktreePath)).kind === "unavailable") {
        return unavailableOutput(startedAt);
      }
    }

    const port = await this.operations.allocatePort().catch(() => undefined);
    if (!port) {
      return unavailableOutput(startedAt);
    }
    const baseUrl = `http://127.0.0.1:${port}`;
    const server = await this.operations.start(buildStartCommand(policyResult.policy, port), {
      cwd: worktreePath,
      env: { ...environment, FAILSPEC_BASE_URL: baseUrl, FAILSPEC_MANAGED_SERVER: "1" },
      timeoutMs: startupTimeoutMs,
      logPath: output.serverLog
    }).catch(() => undefined);
    if (!server) {
      return unavailableOutput(startedAt);
    }

    try {
      if (!(await this.operations.waitForReady(baseUrl))) {
        return unavailableOutput(startedAt);
      }
      const result = await this.operations.run(testCommand(policyResult.policy, output.artifactsPath), {
        cwd: worktreePath,
        env: { ...environment, FAILSPEC_BASE_URL: baseUrl, FAILSPEC_MANAGED_SERVER: "1" },
        timeoutMs: testTimeoutMs
      });
      if (!(await writeOwnedOutput(output.reportPath, result.stdout)) || !(await writeOwnedOutput(output.stderrLog, result.stderr))) {
        return unavailableOutput(startedAt);
      }
      return outputFromResult(result, worktreePath, output.artifactsPath);
    } finally {
      await server.stop().catch(() => undefined);
    }
  }
}

function testCommand(policy: RepositoryCommandPolicy, artifactsPath: string): NpmCommand {
  const relativeArtifacts = relative(policy.repositoryPath, artifactsPath);
  return {
    command: "npm",
    args: [...buildTestCommand(policy).args, "--", "--reporter=json", "--output", relativeArtifacts]
  };
}

async function stagedTestWorktree(repositoryPath: string, generatedTestPath: string | undefined): Promise<string | undefined> {
  if (generatedTestPath !== stagedGeneratedTestPath) {
    return undefined;
  }
  try {
    const worktreePath = await realpath(repositoryPath);
    if (!(await stat(worktreePath)).isDirectory()) {
      return undefined;
    }
    const testPath = join(worktreePath, stagedGeneratedTestPath);
    const entry = await lstat(testPath);
    const resolvedTestPath = await realpath(testPath);
    return entry.isFile() && !entry.isSymbolicLink() && resolvedTestPath === testPath ? worktreePath : undefined;
  } catch {
    return undefined;
  }
}

async function runnerPaths(worktreePath: string): Promise<{ reportPath: string; stderrLog: string; serverLog: string; artifactsPath: string } | undefined> {
  const directory = await ownedDirectory(worktreePath, ".failspec");
  const runnerDirectory = directory && await ownedDirectory(directory, "runner");
  const artifactsPath = runnerDirectory && await ownedDirectory(runnerDirectory, "artifacts");
  if (!runnerDirectory || !artifactsPath) {
    return undefined;
  }
  return {
    reportPath: join(runnerDirectory, "playwright-report.json"),
    stderrLog: join(runnerDirectory, "playwright.stderr.log"),
    serverLog: join(runnerDirectory, "server.log"),
    artifactsPath
  };
}

async function ownedDirectory(parent: string, name: string): Promise<string | undefined> {
  const path = join(parent, name);
  let entry = await lstat(path).catch(() => undefined);
  if (!entry) {
    await mkdir(path);
    entry = await lstat(path);
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    return undefined;
  }
  const canonicalPath = await realpath(path);
  return isInside(parent, canonicalPath) ? canonicalPath : undefined;
}

async function writeOwnedOutput(path: string, content: string): Promise<boolean> {
  try {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content, "utf8");
      return true;
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function outputFromResult(result: CommandResult, worktreePath: string, artifactsPath: string): RunnerOutput {
  const evidence = result.timedOut ? emptyEvidence("timedOut") : parseEvidence(result.stdout, worktreePath, artifactsPath);
  return {
    execution: {
      command: "controlled_playwright_generated_test",
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.timedOut ? "Playwright execution timed out." : "Playwright execution completed.",
      stderr: "",
      durationMs: result.durationMs,
      artifacts: evidence.artifactPaths
    },
    evidence
  };
}

function unavailableOutput(startedAt: number): RunnerOutput {
  return {
    execution: {
      command: "controlled_playwright_generated_test",
      exitCode: null,
      timedOut: false,
      stdout: "Controlled Playwright execution was unavailable.",
      stderr: "",
      durationMs: Date.now() - startedAt,
      artifacts: []
    },
    evidence: emptyEvidence("unknown")
  };
}

function parseEvidence(report: string, worktreePath: string, artifactsPath: string): ExecutionEvidence {
  try {
    const result = findTestResult(JSON.parse(report));
    if (!result) {
      return emptyEvidence("unknown");
    }
    const errors = Array.isArray(result.errors) ? result.errors : [];
    const error = asRecord(errors[0]);
    const location = asRecord(error.location);
    const matcher = asRecord(error.matcherResult);
    return {
      testTitle: text(result.title),
      testStatus: status(result.status),
      assertionFailureMessage: text(error.message),
      expectedValue: text(matcher.expected),
      actualValue: text(matcher.actual),
      failureLocation: location.file && containedPath(worktreePath, String(location.file))
        ? {
            file: containedPath(worktreePath, String(location.file))!,
            line: positiveNumber(location.line),
            column: positiveNumber(location.column)
          }
        : undefined,
      consoleErrors: [],
      pageErrors: [],
      artifactPaths: artifactPaths(result.attachments, worktreePath, artifactsPath)
    };
  } catch {
    return emptyEvidence("unknown");
  }
}

function findTestResult(report: unknown): Record<string, unknown> | undefined {
  const pending: Array<{ value: unknown; title?: string }> = [{ value: report }];
  let visited = 0;
  while (pending.length > 0 && ++visited <= 10_000) {
    const item = pending.pop();
    const current = asRecord(item?.value);
    const title = typeof current.title === "string" ? current.title : item?.title;
    if (Array.isArray(current.results) && current.results.length > 0) {
      const result = asRecord(current.results[0]);
      return { ...result, title: title ?? result.title };
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        pending.push(...value.map((entry) => ({ value: entry, title })));
      } else if (typeof value === "object" && value !== null) {
        pending.push({ value, title });
      }
    }
  }
  return undefined;
}

function artifactPaths(value: unknown, worktreePath: string, artifactsPath: string): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((attachment) => {
    const path = asRecord(attachment).path;
    const normalized = typeof path === "string" && containedPath(artifactsPath, path);
    return normalized && containedPath(worktreePath, resolve(artifactsPath, normalized)) ? [join(runnerOutputDirectory, "artifacts", normalized)] : [];
  });
}

function containedPath(root: string, candidate: string): string | undefined {
  const resolved = resolve(root, candidate);
  const path = relative(root, resolved);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path) ? path : undefined;
}

function status(value: unknown): ExecutionEvidence["testStatus"] {
  return value === "passed" || value === "failed" || value === "skipped" || value === "timedOut" || value === "interrupted" ? value : "unknown";
}

function emptyEvidence(testStatus: NonNullable<ExecutionEvidence["testStatus"]>): ExecutionEvidence {
  return { testStatus, consoleErrors: [], pageErrors: [], artifactPaths: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const sanitized = value
    .replace(/[A-Za-z]:[\\/][^\s]+/g, "[path]")
    .replace(/\/(?:[^\s/]+\/)+[^\s/]+/g, "[path]")
    .trim()
    .slice(0, maximumEvidenceTextLength);
  return sanitized || undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function runnerEnvironment(): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["PATH", "SystemRoot", "ComSpec", "TEMP", "TMP", "USERPROFILE"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  return Object.fromEntries(names.flatMap((name) => {
    const value = process.env[name];
    return typeof value === "string" ? [[name, value]] : [];
  }));
}

async function allocatePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  return typeof address === "object" && address ? address.port : Promise.reject(new Error("Port unavailable."));
}

async function waitForReady(url: string): Promise<boolean> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(readinessIntervalMs) });
      if (response.ok) {
        return true;
      }
    } catch {
      // The controlled server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, readinessIntervalMs));
  }
  return false;
}

function runCommand(command: NpmCommand, options: CommandOptions): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(command.command, command.args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const append = (current: string, chunk: Buffer) => current.length >= maximumProcessOutputBytes ? current : `${current}${chunk.toString("utf8")}`.slice(0, maximumProcessOutputBytes);
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const settle = (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ exitCode: code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
    };
    child.once("error", () => settle(null));
    child.once("close", settle);
  });
}

async function startCommand(command: NpmCommand, options: CommandOptions): Promise<RunningCommand> {
  const child = spawn(command.command, command.args, { cwd: options.cwd, env: options.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let closed = false;
  const closedPromise = new Promise<void>((resolvePromise) => {
    const settled = () => {
      closed = true;
      resolvePromise();
    };
    child.once("close", settled);
    child.once("error", settled);
  });
  const append = (chunk: Buffer) => { output = `${output}${chunk.toString("utf8")}`.slice(0, maximumProcessOutputBytes); };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return {
    async stop() {
      if (!child.killed) {
        child.kill();
      }
      if (!closed) {
        await closedPromise;
      }
      if (options.logPath) {
        await writeOwnedOutput(options.logPath, output);
      }
    }
  };
}
