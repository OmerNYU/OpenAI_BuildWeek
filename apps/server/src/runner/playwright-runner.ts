import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises";
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
  isRunning(): boolean;
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
    const worktreePath = await stagedTestWorktree(input.repositoryPath, input.generatedTest.path, input.generatedTest.content);
    if (!worktreePath) {
      return unavailableOutput(startedAt);
    }

    const policyResult = await this.operations.createPolicy(worktreePath);
    if (policyResult.status !== "ready") {
      return unavailableOutput(startedAt);
    }
    const output = await runnerPaths(worktreePath);
    if (!output || !(await outputFilesAreAbsent(output))) {
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
      if (!server.isRunning() || !(await this.operations.waitForReady(baseUrl)) || !server.isRunning()) {
        return unavailableOutput(startedAt);
      }
      const result = await this.operations.run(testCommand(policyResult.policy, output.artifactsPath), {
        cwd: worktreePath,
        env: {
          ...environment,
          FAILSPEC_BASE_URL: baseUrl,
          FAILSPEC_MANAGED_SERVER: "1",
          PLAYWRIGHT_JSON_OUTPUT_NAME: output.reportPath
        },
        timeoutMs: testTimeoutMs
      });
      const report = result.timedOut ? undefined : await readOwnedOutput(output.reportPath);
      await writeOwnedOutput(output.stderrLog, result.stderr);
      return outputFromResult(result, report, worktreePath, output.artifactsPath);
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

async function stagedTestWorktree(repositoryPath: string, generatedTestPath: string | undefined, generatedTestContent: string): Promise<string | undefined> {
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
    return entry.isFile() && !entry.isSymbolicLink() && resolvedTestPath === testPath && await readFile(testPath, "utf8") === generatedTestContent
      ? worktreePath
      : undefined;
  } catch {
    return undefined;
  }
}

async function outputFilesAreAbsent(paths: { reportPath: string; stderrLog: string; serverLog: string }): Promise<boolean> {
  return Promise.all([paths.reportPath, paths.stderrLog, paths.serverLog].map(async (path) => !(await lstat(path).catch(() => undefined)))).then((result) => result.every(Boolean));
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

async function readOwnedOutput(path: string): Promise<string | undefined> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > maximumProcessOutputBytes || await realpath(path) !== path) {
      return undefined;
    }
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function outputFromResult(result: CommandResult, report: string | undefined, worktreePath: string, artifactsPath: string): Promise<RunnerOutput> {
  const evidence = result.timedOut ? emptyEvidence("timedOut") : report === undefined ? emptyEvidence("unknown") : await parseEvidence(report, worktreePath, artifactsPath);
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

async function parseEvidence(report: string, worktreePath: string, artifactsPath: string): Promise<ExecutionEvidence> {
  try {
    const results = finalResults(JSON.parse(report));
    if (results.length === 0) {
      return emptyEvidence("unknown");
    }
    const selected = [...results].sort((left, right) => left.project.localeCompare(right.project) || left.index - right.index);
    const result = selected[0]!;
    const error = selected.map((entry) => firstError(entry.result)).find((entry) => Object.keys(entry).length > 0) ?? {};
    const location = asRecord(error.location);
    const matcher = asRecord(error.matcherResult);
    return {
      testTitle: text(result.title, worktreePath),
      testStatus: aggregateStatus(selected.map((entry) => entry.result.status)),
      assertionFailureMessage: text(error.message, worktreePath),
      expectedValue: text(matcher.expected, worktreePath),
      actualValue: text(matcher.actual, worktreePath),
      failureLocation: location.file && containedPath(worktreePath, String(location.file))
        ? {
            file: containedPath(worktreePath, String(location.file))!,
            line: positiveNumber(location.line),
            column: positiveNumber(location.column)
          }
        : undefined,
      consoleErrors: [],
      pageErrors: [],
      artifactPaths: await artifactPaths(selected.flatMap((entry) => Array.isArray(entry.result.attachments) ? entry.result.attachments : []), worktreePath, artifactsPath)
    };
  } catch {
    return emptyEvidence("unknown");
  }
}

interface ReporterResult {
  result: Record<string, unknown>;
  title?: string;
  project: string;
  index: number;
}

function finalResults(report: unknown): ReporterResult[] {
  const pending: Array<{ value: unknown; title?: string; project?: string }> = [{ value: report }];
  const attempts = new Map<string, ReporterResult>();
  let visited = 0;
  while (pending.length > 0 && ++visited <= 10_000) {
    const item = pending.pop();
    const current = asRecord(item?.value);
    const title = typeof current.title === "string" ? current.title : item?.title;
    const project = typeof current.projectName === "string" ? current.projectName : item?.project ?? "default";
    if (Array.isArray(current.results)) {
      for (const [index, value] of current.results.entries()) {
        const result = asRecord(value);
        const attempt = typeof result.retry === "number" ? result.retry : index;
        const key = `${project}\u0000${title ?? ""}`;
        const previous = attempts.get(key);
        if (!previous || attempt >= previous.index) {
          attempts.set(key, { result: { ...result, title: title ?? result.title }, title, project, index: attempt });
        }
      }
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        pending.push(...value.map((entry) => ({ value: entry, title, project })));
      } else if (typeof value === "object" && value !== null) {
        pending.push({ value, title, project });
      }
    }
  }
  return [...attempts.values()];
}

function firstError(result: Record<string, unknown>): Record<string, unknown> {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return asRecord(errors[0]);
}

async function artifactPaths(value: unknown[], worktreePath: string, artifactsPath: string): Promise<string[]> {
  const paths = await Promise.all(value.map(async (attachment) => {
    const path = asRecord(attachment).path;
    const normalized = typeof path === "string" && containedPath(artifactsPath, path);
    if (!normalized || !containedPath(worktreePath, resolve(artifactsPath, normalized))) {
      return undefined;
    }
    const artifact = resolve(artifactsPath, normalized);
    try {
      const entry = await lstat(artifact);
      return entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && await realpath(artifact) === artifact
        ? join(runnerOutputDirectory, "artifacts", normalized)
        : undefined;
    } catch {
      return undefined;
    }
  }));
  return [...new Set(paths.filter((path): path is string => path !== undefined))].sort();
}

function containedPath(root: string, candidate: string): string | undefined {
  const resolved = resolve(root, candidate);
  const path = relative(root, resolved);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path) ? path : undefined;
}

function aggregateStatus(values: unknown[]): NonNullable<ExecutionEvidence["testStatus"]> {
  const statuses = values.map(status);
  return ["failed", "timedOut", "interrupted", "skipped", "passed"].find((candidate) => statuses.includes(candidate as NonNullable<ExecutionEvidence["testStatus"]>)) as NonNullable<ExecutionEvidence["testStatus"]> | undefined ?? "unknown";
}

function status(value: unknown): NonNullable<ExecutionEvidence["testStatus"]> {
  return value === "passed" || value === "failed" || value === "skipped" || value === "timedOut" || value === "interrupted" ? value : "unknown";
}

function emptyEvidence(testStatus: NonNullable<ExecutionEvidence["testStatus"]>): ExecutionEvidence {
  return { testStatus, consoleErrors: [], pageErrors: [], artifactPaths: [] };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, worktreePath: string): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const urls: string[] = [];
  const protectedUrls = value.replace(/https?:\/\/[^\s]+/g, (url) => `[[FAILSPEC_URL_${urls.push(url) - 1}]]`);
  const worktreeVariants = new Set([worktreePath, worktreePath.replaceAll("/", "\\"), worktreePath.replaceAll("\\", "/")]);
  const sanitized = [...worktreeVariants].reduce((current, path) => current.replaceAll(path, "[worktree]"), protectedUrls
    .replace(/[A-Za-z]:[\\/][^\r\n]*/g, "[path]")
    .replace(/\/(?:[^\r\n]*)/g, "[path]"))
    .replace(/\[\[FAILSPEC_URL_(\d+)\]\]/g, (_match, index: string) => urls[Number(index)] ?? "")
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

export async function waitForReady(url: string): Promise<boolean> {
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(readinessIntervalMs) });
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
    isRunning() {
      return !closed;
    },
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
