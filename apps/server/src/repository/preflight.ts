import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type { RepositoryPreflightResult } from "@failspec/contracts";

export const approvedScriptNames = ["dev", "test:generated"] as const;
export const approvedGeneratedTestScript = "playwright test tests/generated";
export const supportedFrameworkPolicies = {
  next: { requiredDependencies: ["next", "react", "react-dom"], devScript: "next dev" },
  vite: { requiredDependencies: ["react", "react-dom", "vite"], devScript: "vite" }
} as const;

type ApprovedScriptName = (typeof approvedScriptNames)[number];
type Failure = Extract<RepositoryPreflightResult, { status: "unsupported" | "failed" }>;
type Framework = "next" | "vite";

export interface NpmCommand {
  command: "npm";
  args: readonly string[];
}

export interface RepositoryCommandPolicy {
  repositoryPath: string;
  framework: Framework;
  startScript: "dev";
  testScript: "test:generated";
}

export type RepositoryCommandPolicyResult =
  | { status: "ready"; policy: RepositoryCommandPolicy }
  | Failure;

export type DependencyInstallPlan =
  | { kind: "install"; command: NpmCommand; logPath: string }
  | { kind: "reuse"; logPath: string }
  | { kind: "unavailable"; reason: "missing_lockfile" | "unsafe_worktree_state" };

export type DependencyInstallStateResult =
  | { kind: "recorded" }
  | { kind: "appended"; logPath: string }
  | { kind: "unavailable"; reason: "missing_lockfile" | "unsafe_worktree_state" };

export type DependencyInstallLogResult =
  | { kind: "ready"; logPath: string }
  | { kind: "unavailable"; reason: "unsafe_worktree_state" };

export type GitCommandResult =
  | { kind: "completed"; exitCode: number | null; output: string }
  | { kind: "output" }
  | { kind: "timeout" }
  | { kind: "output_limit" }
  | { kind: "failed" };

export interface GitRunner {
  run(
    cwd: string,
    args: readonly string[],
    options: { timeoutMs: number; maxOutputBytes: number; stopOnOutput: boolean }
  ): Promise<GitCommandResult>;
}

export interface PreflightOptions {
  gitRunner?: GitRunner;
}

interface PackageJson {
  packageManager?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  scripts?: unknown;
}

interface ValidatedWorktreeState {
  worktreePath: string;
  statePath: string;
  logPath: string;
}

const installStateDirectory = ".failspec";
const installStateFile = "npm-install-state.json";
const installLogFile = "npm-install.log";
const gitTimeoutMs = 2_000;
const gitRevParseOutputLimit = 4_096;
const runnerConfigurationMarkers = ["FAILSPEC_BASE_URL", "FAILSPEC_MANAGED_SERVER"];

export async function preflightRepository(
  repositoryPath: string,
  options: PreflightOptions = {}
): Promise<RepositoryPreflightResult> {
  const canonicalPath = await canonicalDirectory(repositoryPath);
  if (!canonicalPath) {
    return failed("unsafe_path");
  }

  const gitRunner = options.gitRunner ?? systemGitRunner;
  const gitRoot = await gitRunner.run(canonicalPath, ["rev-parse", "--show-toplevel"], {
    timeoutMs: gitTimeoutMs,
    maxOutputBytes: gitRevParseOutputLimit,
    stopOnOutput: false
  });
  if (gitRoot.kind !== "completed") {
    return failed("inspection_failed");
  }
  if (gitRoot.exitCode !== 0 || await canonicalGitDirectory(gitRoot.output) !== canonicalPath) {
    return unsupported("not_git_repository");
  }

  const status = await gitRunner.run(canonicalPath, ["status", "--porcelain", "--untracked-files=normal"], {
    timeoutMs: gitTimeoutMs,
    maxOutputBytes: 1,
    stopOnOutput: true
  });
  if (status.kind === "output") {
    return unsupported("dirty_repository");
  }
  if (status.kind === "completed" && status.output.length > 0) {
    return unsupported("dirty_repository");
  }
  if (status.kind !== "completed" || status.exitCode !== 0) {
    return failed("inspection_failed");
  }

  const packageJson = await readPackageJson(canonicalPath);
  if (!packageJson) {
    return failed("inspection_failed");
  }
  if (!(await isNpmRepository(packageJson, canonicalPath))) {
    return unsupported("unsupported_package_manager");
  }

  if (!(await hasPlaywrightSetup(canonicalPath, packageJson))) {
    return unsupported("playwright_not_configured");
  }
  if (!hasApprovedScripts(packageJson)) {
    return unsupported("unsupported_script");
  }
  if (!detectFramework(packageJson)) {
    return unsupported("unsupported_framework");
  }

  return { status: "ready", repositoryPath: canonicalPath };
}

export async function createCommandPolicy(
  repositoryPath: string,
  options: PreflightOptions = {}
): Promise<RepositoryCommandPolicyResult> {
  const preflight = await preflightRepository(repositoryPath, options);
  if (preflight.status !== "ready") {
    return preflight;
  }

  const packageJson = await readPackageJson(preflight.repositoryPath);
  const framework = packageJson && detectFramework(packageJson);
  if (!framework) {
    return failed("inspection_failed");
  }

  return {
    status: "ready",
    policy: {
      repositoryPath: preflight.repositoryPath,
      framework,
      startScript: "dev",
      testScript: "test:generated"
    }
  };
}

export function buildInstallCommand(): NpmCommand {
  return { command: "npm", args: ["ci"] };
}

export function buildStartCommand(policy: RepositoryCommandPolicy, port: number): NpmCommand {
  assertCommandPolicy(policy);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid port.");
  }

  const hostFlag = policy.framework === "next" ? "--hostname" : "--host";
  return {
    command: "npm",
    args: ["run", policy.startScript, "--", hostFlag, "127.0.0.1", "--port", String(port)]
  };
}

export function buildTestCommand(policy: RepositoryCommandPolicy): NpmCommand {
  assertCommandPolicy(policy);
  return { command: "npm", args: ["run", policy.testScript] };
}

export async function planDependencyInstall(worktreePath: string): Promise<DependencyInstallPlan> {
  const state = await validatedWorktreeState(worktreePath);
  if (!state) {
    return unavailable("unsafe_worktree_state");
  }

  const lockfile = await readLockfile(state.worktreePath);
  if (!lockfile) {
    return unavailable("missing_lockfile");
  }

  const recordedHash = await readFile(state.statePath, "utf8").catch(() => undefined);
  const stateIsTracked = await isTrackedByRepository(state.worktreePath, installStateFile);
  if (stateIsTracked === undefined) {
    return unavailable("unsafe_worktree_state");
  }
  if (!stateIsTracked && recordedHash === lockfileHash(lockfile) && await hasInstalledDependencies(state.worktreePath)) {
    return { kind: "reuse", logPath: state.logPath };
  }

  return { kind: "install", command: buildInstallCommand(), logPath: state.logPath };
}

export async function initializeDependencyInstallLog(
  worktreePath: string
): Promise<DependencyInstallLogResult> {
  const state = await validatedWorktreeState(worktreePath);
  if (!state) {
    return unavailable("unsafe_worktree_state");
  }
  if (await isTrackedByRepository(state.worktreePath, installLogFile) !== false) {
    return unavailable("unsafe_worktree_state");
  }

  await appendFile(state.logPath, "", "utf8");
  return { kind: "ready", logPath: state.logPath };
}

export async function appendDependencyInstallLog(
  worktreePath: string,
  output: string
): Promise<DependencyInstallStateResult> {
  const initialized = await initializeDependencyInstallLog(worktreePath);
  if (initialized.kind === "unavailable") {
    return initialized;
  }

  await appendFile(initialized.logPath, output, "utf8");
  return { kind: "appended", logPath: initialized.logPath };
}

export async function recordDependencyInstall(
  worktreePath: string
): Promise<DependencyInstallStateResult> {
  const state = await validatedWorktreeState(worktreePath);
  if (!state) {
    return unavailable("unsafe_worktree_state");
  }

  const lockfile = await readLockfile(state.worktreePath);
  if (!lockfile) {
    return unavailable("missing_lockfile");
  }

  const stateIsTracked = await isTrackedByRepository(state.worktreePath, installStateFile);
  if (stateIsTracked !== false) {
    return unavailable("unsafe_worktree_state");
  }

  await writeFile(state.statePath, lockfileHash(lockfile), "utf8");
  return { kind: "recorded" };
}

const systemGitRunner: GitRunner = {
  run(cwd, args, options) {
    return runGit(cwd, args, options);
  }
};

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const canonicalPath = await realpath(path);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalGitDirectory(output: string): Promise<string | undefined> {
  const reportedPath = output.trim();
  if (!reportedPath) {
    return undefined;
  }
  try {
    const canonicalPath = await realpath(reportedPath.replace(/[\\/]/g, sep));
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function validatedWorktreeState(worktreePath: string): Promise<ValidatedWorktreeState | undefined> {
  const canonicalWorktreePath = await canonicalDirectory(worktreePath);
  if (!canonicalWorktreePath) {
    return undefined;
  }

  const stateDirectory = join(canonicalWorktreePath, installStateDirectory);
  let entry = await lstatOrUndefined(stateDirectory);
  if (!entry) {
    await mkdir(stateDirectory, { recursive: true });
    entry = await lstatOrUndefined(stateDirectory);
  }
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
    return undefined;
  }

  const canonicalStateDirectory = await realpath(stateDirectory).catch(() => undefined);
  if (!canonicalStateDirectory || !isInside(canonicalWorktreePath, canonicalStateDirectory)) {
    return undefined;
  }

  const statePath = join(canonicalStateDirectory, installStateFile);
  const logPath = join(canonicalStateDirectory, installLogFile);
  if (!(await isSafeStateFile(statePath)) || !(await isSafeStateFile(logPath))) {
    return undefined;
  }

  return { worktreePath: canonicalWorktreePath, statePath, logPath };
}

async function isSafeStateFile(path: string): Promise<boolean> {
  const entry = await lstatOrUndefined(path);
  return !entry || (!entry.isSymbolicLink() && entry.isFile());
}

async function hasInstalledDependencies(worktreePath: string): Promise<boolean> {
  const entry = await lstatOrUndefined(join(worktreePath, "node_modules"));
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink());
}

async function lstatOrUndefined(path: string) {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

async function readLockfile(worktreePath: string): Promise<string | undefined> {
  return readFile(join(worktreePath, "package-lock.json"), "utf8").catch(() => undefined);
}

async function isTrackedByRepository(worktreePath: string, fileName: string): Promise<boolean | undefined> {
  const result = await systemGitRunner.run(worktreePath, [
    "ls-files",
    "--error-unmatch",
    "--",
    join(installStateDirectory, fileName)
  ], {
    timeoutMs: gitTimeoutMs,
    maxOutputBytes: gitRevParseOutputLimit,
    stopOnOutput: false
  });
  if (result.kind !== "completed") {
    return undefined;
  }
  return result.exitCode === 0;
}

function lockfileHash(lockfile: string): string {
  return createHash("sha256").update(lockfile).digest("hex");
}

async function readPackageJson(repositoryPath: string): Promise<PackageJson | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(repositoryPath, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as PackageJson)
      : undefined;
  } catch {
    return undefined;
  }
}

async function isNpmRepository(packageJson: PackageJson, repositoryPath: string): Promise<boolean> {
  const manager = typeof packageJson.packageManager === "string"
    ? packageJson.packageManager.split("@")[0]
    : undefined;
  if (manager && manager !== "npm") {
    return false;
  }

  const hasUnsupportedLockfile = await Promise.all(
    ["pnpm-lock.yaml", "yarn.lock"].map((name) =>
      readFile(join(repositoryPath, name)).then(() => true).catch(() => false)
    )
  );
  if (hasUnsupportedLockfile.some(Boolean)) {
    return false;
  }

  return Boolean(await readLockfile(repositoryPath));
}

function detectFramework(packageJson: PackageJson): Framework | undefined {
  const dependencies = dependencyNames(packageJson);
  const devScript = scriptValue(packageJson, "dev");
  if (
    supportedFrameworkPolicies.next.requiredDependencies.every((dependency) => dependencies.has(dependency)) &&
    devScript === supportedFrameworkPolicies.next.devScript
  ) {
    return "next";
  }
  if (
    supportedFrameworkPolicies.vite.requiredDependencies.every((dependency) => dependencies.has(dependency)) &&
    devScript === supportedFrameworkPolicies.vite.devScript
  ) {
    return "vite";
  }
  return undefined;
}

function dependencyNames(packageJson: PackageJson): Set<string> {
  return new Set([
    ...Object.keys(asRecord(packageJson.dependencies)),
    ...Object.keys(asRecord(packageJson.devDependencies))
  ]);
}

async function hasPlaywrightSetup(repositoryPath: string, packageJson: PackageJson): Promise<boolean> {
  if (!dependencyNames(packageJson).has("@playwright/test")) {
    return false;
  }

  const configurations = await Promise.all(
    ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"].map((name) =>
      readFile(join(repositoryPath, name), "utf8").catch(() => undefined)
    )
  );
  return configurations.some((configuration) =>
    configuration !== undefined && runnerConfigurationMarkers.every((marker) => configuration.includes(marker))
  );
}

function hasApprovedScripts(packageJson: PackageJson): packageJson is PackageJson & {
  scripts: Record<ApprovedScriptName, string>;
} {
  return (
    approvedScriptNames.every((script) => Boolean(scriptValue(packageJson, script))) &&
    scriptValue(packageJson, "test:generated") === approvedGeneratedTestScript
  );
}

function scriptValue(packageJson: PackageJson, script: string): string | undefined {
  const value = asRecord(packageJson.scripts)[script];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assertCommandPolicy(policy: RepositoryCommandPolicy): void {
  if (
    (policy.framework !== "next" && policy.framework !== "vite") ||
    policy.startScript !== "dev" ||
    policy.testScript !== "test:generated"
  ) {
    throw new Error("Invalid command policy.");
  }
}

function unavailable<T extends "missing_lockfile" | "unsafe_worktree_state">(reason: T) {
  return { kind: "unavailable" as const, reason };
}

function unsupported(code: Failure["failure"]["code"]): Failure {
  return { status: "unsupported", failure: { code } };
}

function failed(code: Failure["failure"]["code"]): Failure {
  return { status: "failed", failure: { code } };
}

function runGit(
  cwd: string,
  args: readonly string[],
  options: { timeoutMs: number; maxOutputBytes: number; stopOnOutput: boolean }
): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      shell: false,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let settled = false;
    let output = "";
    let outputBytes = 0;
    const settle = (result: GitCommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      child.kill();
      settle({ kind: "timeout" });
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (options.stopOnOutput && chunk.length > 0) {
        child.kill();
        settle({ kind: "output" });
        return;
      }
      outputBytes += chunk.length;
      if (outputBytes > options.maxOutputBytes) {
        child.kill();
        settle({ kind: "output_limit" });
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("error", () => settle({ kind: "failed" }));
    child.once("close", (exitCode) => settle({ kind: "completed", exitCode, output }));
  });
}
