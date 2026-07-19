import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { WorktreeFailureCode, WorktreePreparationResult } from "@failspec/contracts";

const gitTimeoutMs = 10_000;
const gitOutputLimit = 16_384;

interface OwnershipMetadata {
  investigationId: string;
  sourceRepositoryPath: string;
  worktreePath: string;
  creationComplete: boolean;
}

export interface WorktreeGitResult {
  kind: "completed" | "timeout" | "failed" | "output_limit";
  exitCode?: number | null;
  output?: string;
}

export interface WorktreeGitRunner {
  run(cwd: string, args: readonly string[]): Promise<WorktreeGitResult>;
}

export interface WorktreeOptions {
  /** Test-only root injection. Production roots are selected by platform policy. */
  testRootPath?: string;
  gitRunner?: WorktreeGitRunner;
  /** Test-only failure and platform seams; never a runtime configuration surface. */
  testHooks?: {
    platform?: NodeJS.Platform;
    environment?: NodeJS.ProcessEnv;
    beforeMetadataUpdate?: () => void | Promise<void>;
  };
}

interface RootConfiguration {
  path: string;
  windowsApplicationPath?: string;
  testOnly: boolean;
  platform: NodeJS.Platform;
}

export type WorktreeCleanupResult =
  | { status: "cleaned" }
  | { status: "failed"; failure: { code: WorktreeFailureCode } };

export async function prepareIsolatedWorktree(
  sourceRepositoryPath: string,
  investigationId: string,
  options: WorktreeOptions = {}
): Promise<WorktreePreparationResult> {
  const attempt = await prepareIsolatedWorktreeAttempt(
    sourceRepositoryPath,
    investigationId,
    options
  );
  return attempt.status === "prepared"
    ? {
        status: "prepared",
        investigationId,
        sourceRepositoryPath: attempt.sourceRepositoryPath,
        worktreePath: attempt.worktreePath
      }
    : preparationFailure(attempt.failure);
}

export async function prepareIsolatedWorktreeAttempt(
  sourceRepositoryPath: string,
  investigationId: string,
  options: WorktreeOptions = {}
): Promise<WorktreePreparationAttempt> {
  const rootConfiguration = await configuredRoot(options);
  const rootPath = await ownedRoot(rootConfiguration, true);
  const sourcePath = await canonicalDirectory(sourceRepositoryPath);
  if (!rootPath || !isSafeInvestigationId(investigationId)) {
    return attemptFailure("invalid_destination");
  }
  if (!sourcePath) {
    return attemptFailure("creation_failed");
  }

  const worktreePath = join(rootPath, investigationId);
  if (!isInside(rootPath, worktreePath) || await exists(worktreePath)) {
    return attemptFailure("invalid_destination");
  }

  const metadataPath = join(rootPath, `${investigationId}.json`);
  if (!isInside(rootPath, metadataPath) || await exists(metadataPath)) {
    return attemptFailure("invalid_destination");
  }

  const gitRunner = options.gitRunner ?? systemGitRunner;
  const sourceRoot = await gitRunner.run(sourcePath, ["rev-parse", "--show-toplevel"]);
  if (
    sourceRoot.kind !== "completed" ||
    sourceRoot.exitCode !== 0 ||
    await canonicalGitDirectory(sourceRoot.output, rootConfiguration?.platform) !== sourcePath
  ) {
    return attemptFailure("creation_failed");
  }

  const metadata: OwnershipMetadata = {
    investigationId,
    sourceRepositoryPath: sourcePath,
    worktreePath,
    creationComplete: false
  };
  if (!(await writeMetadata(metadataPath, metadata, true))) {
    return attemptFailure("metadata_failed");
  }

  let created: WorktreeGitResult;
  try {
    created = await gitRunner.run(sourcePath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
  } catch {
    return attemptFailure("creation_failed", true);
  }
  if (created.kind !== "completed" || created.exitCode !== 0) {
    return attemptFailure("creation_failed", true);
  }

  metadata.creationComplete = true;
  if (!(await writeMetadata(metadataPath, metadata, false, options.testHooks?.beforeMetadataUpdate))) {
    return attemptFailure("metadata_failed", true);
  }

  return { status: "prepared", sourceRepositoryPath: sourcePath, worktreePath };
}

export async function cleanupIsolatedWorktree(
  investigationId: string,
  options: WorktreeOptions = {}
): Promise<WorktreeCleanupResult> {
  const rootConfiguration = await configuredRoot(options);
  const rootPath = await ownedRoot(rootConfiguration, false);
  if (!rootPath || !isSafeInvestigationId(investigationId)) {
    return cleanupFailure();
  }

  const worktreePath = join(rootPath, investigationId);
  const metadataPath = join(rootPath, `${investigationId}.json`);
  if (
    !isInside(rootPath, worktreePath) ||
    !isInside(rootPath, metadataPath)
  ) {
    return cleanupFailure();
  }

  const metadataResult = await readMetadata(metadataPath);
  const destinationExists = await exists(worktreePath);
  if (metadataResult.kind === "absent" && !destinationExists) {
    return { status: "cleaned" };
  }
  if (metadataResult.kind !== "valid") {
    return cleanupFailure();
  }
  const metadata = metadataResult.metadata;
  if (
    metadata.investigationId !== investigationId ||
    metadata.worktreePath !== worktreePath ||
    !(await canonicalDirectory(metadata.sourceRepositoryPath))
  ) {
    return cleanupFailure();
  }

  if (!destinationExists) {
    return (await removeMetadata(metadataPath)) ? { status: "cleaned" } : cleanupFailure();
  }
  if (!(await isOwnedDestination(rootPath, worktreePath))) {
    return cleanupFailure();
  }

  const gitRunner = options.gitRunner ?? systemGitRunner;
  const listed = await gitRunner.run(metadata.sourceRepositoryPath, ["worktree", "list", "--porcelain"]);
  const recognized = listed.kind === "completed" && listed.exitCode === 0 &&
    await gitListsWorktree(listed.output, worktreePath, rootConfiguration?.platform);

  if (recognized) {
    const removed = await gitRunner.run(metadata.sourceRepositoryPath, ["worktree", "remove", "--force", worktreePath]);
    if (removed.kind !== "completed" || removed.exitCode !== 0) {
      return cleanupFailure();
    }
    if (await exists(worktreePath)) {
      return cleanupFailure();
    }
  } else {
    return cleanupFailure();
  }

  return (await removeMetadata(metadataPath)) ? { status: "cleaned" } : cleanupFailure();
}

async function configuredRoot(options: WorktreeOptions): Promise<RootConfiguration | undefined> {
  const platform = options.testHooks?.platform ?? process.platform;
  if (options.testRootPath) {
    return { path: options.testRootPath, testOnly: true, platform };
  }
  if (platform === "win32") {
    return windowsRoot(options.testHooks?.environment ?? process.env, platform);
  }
  return realpath(tmpdir())
    .then((path) => ({ path: join(path, "failspec-worktrees"), testOnly: false, platform }))
    .catch(() => undefined);
}

async function windowsRoot(environment: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<RootConfiguration | undefined> {
  const localAppData = environment.LOCALAPPDATA;
  if (!localAppData || !isAbsolute(localAppData) || resolve(localAppData) !== localAppData) {
    return undefined;
  }
  const canonicalLocalAppData = await canonicalDirectory(localAppData);
  if (!canonicalLocalAppData) {
    return undefined;
  }

  const applicationPath = join(canonicalLocalAppData, "FailSpec");
  if (!(await hasCanonicalUnsymlinkedPath(applicationPath))) {
    return undefined;
  }
  try {
    await mkdir(applicationPath, { recursive: true });
    if (!(await hasCanonicalUnsymlinkedPath(applicationPath))) {
      return undefined;
    }
    const canonicalApplicationPath = await realpath(applicationPath);
    if (!isInside(canonicalLocalAppData, canonicalApplicationPath)) {
      return undefined;
    }
    return {
      path: join(canonicalApplicationPath, "worktrees"),
      windowsApplicationPath: canonicalApplicationPath,
      testOnly: false,
      platform
    };
  } catch {
    return undefined;
  }
}

async function ownedRoot(configuration: RootConfiguration | undefined, create: boolean): Promise<string | undefined> {
  try {
    if (!configuration || !(await hasCanonicalUnsymlinkedPath(configuration.path))) {
      return undefined;
    }
    if (create) {
      await mkdir(configuration.path, { recursive: true, mode: 0o700 });
    }
    if (!(await hasCanonicalUnsymlinkedPath(configuration.path))) {
      return undefined;
    }
    const entry = await lstat(configuration.path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      return undefined;
    }
    const canonicalPath = await realpath(configuration.path);
    if (canonicalPath !== configuration.path) {
      return undefined;
    }
    if (configuration.windowsApplicationPath) {
      return isInside(configuration.windowsApplicationPath, canonicalPath) ? canonicalPath : undefined;
    }
    return (configuration.platform === "win32" && configuration.testOnly) || isPrivateToCurrentUser(await stat(configuration.path))
      ? canonicalPath
      : undefined;
  } catch {
    return undefined;
  }
}

function isPrivateToCurrentUser(entry: Awaited<ReturnType<typeof stat>>): boolean {
  return typeof process.getuid === "function" &&
    entry.uid === process.getuid() &&
    (Number(entry.mode) & 0o022) === 0;
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    if (!(await hasCanonicalUnsymlinkedPath(path))) {
      return undefined;
    }
    const canonicalPath = await realpath(path);
    return canonicalPath === path && (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function canonicalGitDirectory(output: string | undefined, platform = process.platform): Promise<string | undefined> {
  if (!output) {
    return undefined;
  }
  try {
    const reportedPath = output.trim().replace(/[\\/]/g, platform === "win32" ? sep : "/");
    const canonicalPath = await realpath(reportedPath);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function gitListsWorktree(output: string | undefined, worktreePath: string, platform = process.platform): Promise<boolean> {
  if (!output) {
    return false;
  }
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ") && await canonicalGitDirectory(line.slice("worktree ".length), platform) === worktreePath) {
      return true;
    }
  }
  return false;
}

async function hasCanonicalUnsymlinkedPath(path: string): Promise<boolean> {
  if (!isAbsolute(path) || resolve(path) !== path) {
    return false;
  }
  let current = parse(path).root;
  for (const segment of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, segment);
    const entry = await lstat(current).catch(() => undefined);
    if (!entry) {
      return true;
    }
    if (entry.isSymbolicLink()) {
      return false;
    }
  }
  return true;
}

function isSafeInvestigationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

async function exists(path: string): Promise<boolean> {
  return Boolean(await lstat(path).catch(() => undefined));
}

async function isOwnedDestination(rootPath: string, worktreePath: string): Promise<boolean> {
  const entry = await lstat(worktreePath).catch(() => undefined);
  return Boolean(entry?.isDirectory() && !entry.isSymbolicLink() && isInside(rootPath, worktreePath));
}

async function writeMetadata(
  path: string,
  metadata: OwnershipMetadata,
  exclusive: boolean,
  beforeUpdate?: () => void | Promise<void>
): Promise<boolean> {
  const serialized = JSON.stringify(metadata);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    if (!exclusive) {
      if (!(await isSafeMetadataFile(path))) {
        return false;
      }
      const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const entry = await existing.stat();
      await existing.close();
      if (!entry.isFile()) {
        return false;
      }
      await beforeUpdate?.();
    }
    const handle = await open(
      exclusive ? path : temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(serialized, "utf8");
    await handle.close();
    if (!exclusive) {
      await rename(temporaryPath, path);
    }
    return true;
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    return false;
  }
}

type MetadataReadResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "valid"; metadata: OwnershipMetadata };

async function readMetadata(path: string): Promise<MetadataReadResult> {
  const fileState = await metadataFileState(path);
  if (fileState === "absent") {
    return { kind: "absent" };
  }
  if (fileState !== "safe") {
    return { kind: "invalid" };
  }
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const entry = await handle.stat();
    const content = await handle.readFile("utf8");
    await handle.close();
    if (!entry.isFile()) {
      return { kind: "invalid" };
    }
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { kind: "invalid" };
    }
    const candidate = parsed as Record<string, unknown>;
    if (
      typeof candidate.investigationId !== "string" ||
      typeof candidate.sourceRepositoryPath !== "string" ||
      typeof candidate.worktreePath !== "string" ||
      typeof candidate.creationComplete !== "boolean"
    ) {
      return { kind: "invalid" };
    }
    return { kind: "valid", metadata: parsed as OwnershipMetadata };
  } catch (error: unknown) {
    return isMissingFileError(error) ? { kind: "absent" } : { kind: "invalid" };
  }
}

async function isSafeMetadataFile(path: string): Promise<boolean> {
  return (await metadataFileState(path)) === "safe";
}

async function metadataFileState(path: string): Promise<"absent" | "invalid" | "safe"> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isFile()) {
      return "invalid";
    }
    return await realpath(path) === path ? "safe" : "invalid";
  } catch (error: unknown) {
    return isMissingFileError(error) ? "absent" : "invalid";
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function removeMetadata(path: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => undefined);
  if (!entry) {
    return true;
  }
  if (!entry.isSymbolicLink() && !entry.isFile()) {
    return false;
  }
  return unlink(path).then(() => true).catch(() => false);
}

function preparationFailure(code: WorktreeFailureCode): WorktreePreparationResult {
  return { status: "failed", failure: { code } };
}

type WorktreePreparationAttempt =
  | {
      status: "prepared";
      sourceRepositoryPath: string;
      worktreePath: string;
    }
  | {
      status: "failed";
      failure: WorktreeFailureCode;
      cleanupAuthorized: boolean;
    };

function attemptFailure(
  failure: WorktreeFailureCode,
  cleanupAuthorized = false
): WorktreePreparationAttempt {
  return { status: "failed", failure, cleanupAuthorized };
}

function cleanupFailure(): WorktreeCleanupResult {
  return { status: "failed", failure: { code: "cleanup_failed" } };
}

const systemGitRunner: WorktreeGitRunner = {
  run(cwd, args) {
    return runGit(cwd, args);
  }
};

function runGit(cwd: string, args: readonly string[]): Promise<WorktreeGitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", ["-C", cwd, ...args], { shell: false, stdio: ["ignore", "pipe", "ignore"] });
    let settled = false;
    let output = "";
    let outputBytes = 0;
    const settle = (result: WorktreeGitResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        resolve(result);
      }
    };
    const timeout = setTimeout(() => {
      child.kill();
      settle({ kind: "timeout" });
    }, gitTimeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > gitOutputLimit) {
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
