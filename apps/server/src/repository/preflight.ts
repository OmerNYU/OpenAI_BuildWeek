import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { RepositoryPreflightResult } from "@failspec/contracts";

export const approvedScriptNames = ["dev", "test:generated"] as const;

type ApprovedScriptName = (typeof approvedScriptNames)[number];
type Failure = Extract<RepositoryPreflightResult, { status: "unsupported" | "failed" }>;

export interface NpmCommand {
  command: "npm";
  args: readonly string[];
}

export interface RepositoryCommandPolicy {
  repositoryPath: string;
  startScript: "dev";
  testScript: "test:generated";
}

export type RepositoryCommandPolicyResult =
  | { status: "ready"; policy: RepositoryCommandPolicy }
  | Failure;

export interface DependencyInstallPlan {
  kind: "install" | "reuse";
  command?: NpmCommand;
  logPath: string;
}

interface PackageJson {
  packageManager?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

const installStateDirectory = ".failspec";
const installStateFile = "npm-install-state.json";
const installLogFile = "npm-install.log";

export async function preflightRepository(repositoryPath: string): Promise<RepositoryPreflightResult> {
  const canonicalPath = await canonicalDirectory(repositoryPath);
  if (!canonicalPath) {
    return failed("unsafe_path");
  }

  const gitRoot = await git(canonicalPath, ["rev-parse", "--show-toplevel"]);
  if (gitRoot.exitCode !== 0) {
    return unsupported("not_git_repository");
  }
  if (gitRoot.stdout.trim() !== canonicalPath) {
    return unsupported("not_git_repository");
  }

  const status = await git(canonicalPath, ["status", "--porcelain", "--untracked-files=all"]);
  if (status.exitCode !== 0) {
    return failed("inspection_failed");
  }
  if (status.stdout.length > 0) {
    return unsupported("dirty_repository");
  }

  const packageJson = await readPackageJson(canonicalPath);
  if (!packageJson) {
    return failed("inspection_failed");
  }
  if (!(await isNpmRepository(packageJson, canonicalPath))) {
    return unsupported("unsupported_package_manager");
  }
  if (!hasSupportedFramework(packageJson)) {
    return unsupported("unsupported_framework");
  }
  if (!(await hasPlaywrightSetup(canonicalPath, packageJson))) {
    return unsupported("playwright_not_configured");
  }
  if (!hasApprovedScripts(packageJson)) {
    return unsupported("unsupported_script");
  }

  return { status: "ready", repositoryPath: canonicalPath };
}

export async function createCommandPolicy(
  repositoryPath: string
): Promise<RepositoryCommandPolicyResult> {
  const preflight = await preflightRepository(repositoryPath);
  if (preflight.status !== "ready") {
    return preflight;
  }

  return {
    status: "ready",
    policy: {
      repositoryPath: preflight.repositoryPath,
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

  return {
    command: "npm",
    args: ["run", policy.startScript, "--", "--hostname", "127.0.0.1", "--port", String(port)]
  };
}

export function buildTestCommand(policy: RepositoryCommandPolicy): NpmCommand {
  assertCommandPolicy(policy);
  return { command: "npm", args: ["run", policy.testScript] };
}

export async function planDependencyInstall(worktreePath: string): Promise<DependencyInstallPlan> {
  const lockfile = await readFile(join(worktreePath, "package-lock.json"), "utf8").catch(() => undefined);
  const logPath = join(worktreePath, installStateDirectory, installLogFile);
  if (!lockfile) {
    return { kind: "install", command: buildInstallCommand(), logPath };
  }

  const statePath = join(worktreePath, installStateDirectory, installStateFile);
  const state = await readFile(statePath, "utf8").catch(() => undefined);
  if (state === createHash("sha256").update(lockfile).digest("hex")) {
    return { kind: "reuse", logPath };
  }

  return { kind: "install", command: buildInstallCommand(), logPath };
}

export async function recordDependencyInstall(worktreePath: string): Promise<void> {
  const lockfile = await readFile(join(worktreePath, "package-lock.json"), "utf8");
  const directory = join(worktreePath, installStateDirectory);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, installStateFile),
    createHash("sha256").update(lockfile).digest("hex"),
    "utf8"
  );
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const canonicalPath = await realpath(path);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function readPackageJson(repositoryPath: string): Promise<PackageJson | undefined> {
  try {
    return JSON.parse(await readFile(join(repositoryPath, "package.json"), "utf8")) as PackageJson;
  } catch {
    return undefined;
  }
}

async function isNpmRepository(packageJson: PackageJson, repositoryPath: string): Promise<boolean> {
  const manager = packageJson.packageManager?.split("@")[0];
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

  return readFile(join(repositoryPath, "package-lock.json")).then(() => true).catch(() => false);
}

function hasSupportedFramework(packageJson: PackageJson): boolean {
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  return "next" in dependencies || ("react" in dependencies && "react-dom" in dependencies);
}

async function hasPlaywrightSetup(repositoryPath: string, packageJson: PackageJson): Promise<boolean> {
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (!("@playwright/test" in dependencies)) {
    return false;
  }

  return (await Promise.all(
    ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"].map((name) =>
      readFile(join(repositoryPath, name)).then(() => true).catch(() => false)
    )
  )).some(Boolean);
}

function hasApprovedScripts(packageJson: PackageJson): packageJson is PackageJson & {
  scripts: Record<ApprovedScriptName, string>;
} {
  return approvedScriptNames.every((script) => Boolean(packageJson.scripts?.[script]));
}

function assertCommandPolicy(policy: RepositoryCommandPolicy): void {
  if (policy.startScript !== "dev" || policy.testScript !== "test:generated") {
    throw new Error("Invalid command policy.");
  }
}

function unsupported(code: Failure["failure"]["code"]): Failure {
  return { status: "unsupported", failure: { code } };
}

function failed(code: Failure["failure"]["code"]): Failure {
  return { status: "failed", failure: { code } };
}

function git(cwd: string, args: readonly string[]): Promise<{ exitCode: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { shell: false });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve({ exitCode, stdout }));
  });
}
