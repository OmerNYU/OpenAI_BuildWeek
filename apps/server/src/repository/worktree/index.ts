import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, stat, unlink } from "node:fs/promises";
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
    generateDestinationSuffix?: () => string;
    afterInitialMetadataOpen?: () => void | Promise<void>;
    beforeInitialMetadataPublish?: () => void | Promise<void>;
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
  if (!rootConfiguration || !rootPath || !isSafeInvestigationId(investigationId)) {
    return attemptFailure("invalid_destination");
  }
  if (!sourcePath) {
    return attemptFailure("creation_failed");
  }

  const metadataPath = join(rootPath, `${investigationId}.json`);
  if (!isInside(rootPath, metadataPath) || await exists(metadataPath)) {
    return attemptFailure("invalid_destination");
  }

  const worktreePath = generatedWorktreePath(
    rootPath,
    investigationId,
    options.testHooks?.generateDestinationSuffix
  );
  if (
    !worktreePath ||
    !(await hasCanonicalUnsymlinkedPath(worktreePath)) ||
    await exists(worktreePath)
  ) {
    return attemptFailure("invalid_destination");
  }

  const provisionalMetadata: OwnershipMetadata = {
    investigationId,
    sourceRepositoryPath: sourcePath,
    worktreePath,
    creationComplete: false
  };
  if (!(await writeInitialMetadata(
    metadataPath,
    provisionalMetadata,
    options.testHooks?.afterInitialMetadataOpen,
    options.testHooks?.beforeInitialMetadataPublish
  ))) {
    return attemptFailure("metadata_failed");
  }

  const gitRunner = options.gitRunner ?? systemGitRunner;
  let sourceRoot: WorktreeGitResult;
  try {
    sourceRoot = await gitRunner.run(sourcePath, ["rev-parse", "--show-toplevel"]);
  } catch {
    return attemptFailure("creation_failed", true);
  }
  if (
    sourceRoot.kind !== "completed" ||
    sourceRoot.exitCode !== 0 ||
    await canonicalGitDirectory(sourceRoot.output, rootConfiguration.platform) !== sourcePath
  ) {
    return attemptFailure("creation_failed", true);
  }

  let created: WorktreeGitResult;
  try {
    created = await gitRunner.run(sourcePath, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
  } catch {
    await removeRecognizedWorktree(sourcePath, worktreePath, rootConfiguration, gitRunner);
    return attemptFailure("creation_failed", true);
  }
  if (created.kind !== "completed" || created.exitCode !== 0) {
    await removeRecognizedWorktree(sourcePath, worktreePath, rootConfiguration, gitRunner);
    return attemptFailure("creation_failed", true);
  }
  if (!(await gitRecognizesWorktree(sourcePath, worktreePath, rootConfiguration, gitRunner))) {
    return attemptFailure("creation_failed", true);
  }

  const completedMetadata: OwnershipMetadata = {
    ...provisionalMetadata,
    creationComplete: true
  };
  if (!(await updateMetadata(
    metadataPath,
    provisionalMetadata,
    completedMetadata,
    options.testHooks?.beforeMetadataUpdate
  ))) {
    await removeRecognizedWorktree(sourcePath, worktreePath, rootConfiguration, gitRunner);
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
  if (!rootConfiguration || !rootPath || !isSafeInvestigationId(investigationId)) {
    return cleanupFailure();
  }

  const metadataPath = join(rootPath, `${investigationId}.json`);
  if (!isInside(rootPath, metadataPath)) {
    return cleanupFailure();
  }

  const metadataResult = await readMetadata(metadataPath);
  if (metadataResult.kind === "absent") {
    return { status: "cleaned" };
  }
  if (metadataResult.kind !== "valid") {
    return cleanupFailure();
  }
  const metadata = metadataResult.metadata;
  if (
    metadata.investigationId !== investigationId ||
    !(await isGeneratedWorktreePath(rootPath, metadata.worktreePath, investigationId)) ||
    await canonicalDirectory(metadata.sourceRepositoryPath) !== metadata.sourceRepositoryPath
  ) {
    return cleanupFailure();
  }
  const worktreePath = metadata.worktreePath;

  if (!(await exists(worktreePath))) {
    return (await removeMetadata(metadataPath)) ? { status: "cleaned" } : cleanupFailure();
  }
  if (!(await isCanonicalDestinationPath(rootPath, worktreePath))) {
    return cleanupFailure();
  }

  const gitRunner = options.gitRunner ?? systemGitRunner;
  if (!(await removeRecognizedWorktree(metadata.sourceRepositoryPath, worktreePath, rootConfiguration, gitRunner))) {
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

async function gitRecognizesWorktree(
  sourceRepositoryPath: string,
  worktreePath: string,
  rootConfiguration: RootConfiguration,
  gitRunner: WorktreeGitRunner
): Promise<boolean> {
  try {
    const listed = await gitRunner.run(sourceRepositoryPath, ["worktree", "list", "--porcelain"]);
    return listed.kind === "completed" &&
      listed.exitCode === 0 &&
      await gitListsWorktree(listed.output, worktreePath, rootConfiguration.platform);
  } catch {
    return false;
  }
}

async function removeRecognizedWorktree(
  sourceRepositoryPath: string,
  worktreePath: string,
  rootConfiguration: RootConfiguration,
  gitRunner: WorktreeGitRunner
): Promise<boolean> {
  if (!(await gitRecognizesWorktree(sourceRepositoryPath, worktreePath, rootConfiguration, gitRunner))) {
    return false;
  }
  try {
    const removed = await gitRunner.run(sourceRepositoryPath, ["worktree", "remove", "--force", worktreePath]);
    return removed.kind === "completed" && removed.exitCode === 0 && !(await exists(worktreePath));
  } catch {
    return false;
  }
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

async function isCanonicalDestinationPath(
  rootPath: string,
  worktreePath: string
): Promise<boolean> {
  const entry = await lstat(worktreePath).catch(() => undefined);
  return Boolean(entry && await isCanonicalDestination(rootPath, worktreePath, entry));
}

async function isCanonicalDestination(
  rootPath: string,
  worktreePath: string,
  entry: Awaited<ReturnType<typeof lstat>>
): Promise<boolean> {
  return entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    isInside(rootPath, worktreePath) &&
    await realpath(worktreePath).catch(() => undefined) === worktreePath;
}

function generatedWorktreePath(
  rootPath: string,
  investigationId: string,
  generateSuffix?: () => string
): string | undefined {
  try {
    const suffix = generateSuffix?.() ?? randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(suffix)) {
      return undefined;
    }
    const worktreePath = join(rootPath, `${investigationId}-${suffix}`);
    return parse(worktreePath).dir === rootPath &&
      resolve(worktreePath) === worktreePath &&
      isInside(rootPath, worktreePath)
      ? worktreePath
      : undefined;
  } catch {
    return undefined;
  }
}

async function isGeneratedWorktreePath(
  rootPath: string,
  worktreePath: string,
  investigationId: string
): Promise<boolean> {
  const prefix = `${investigationId}-`;
  const name = worktreePath.slice(rootPath.length + 1);
  return worktreePath.startsWith(`${rootPath}${sep}`) &&
    name.startsWith(prefix) &&
    name.length > prefix.length &&
    parse(worktreePath).dir === rootPath &&
    resolve(worktreePath) === worktreePath &&
    isInside(rootPath, worktreePath) &&
    /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name.slice(prefix.length)) &&
    await hasCanonicalUnsymlinkedPath(worktreePath);
}

async function writeInitialMetadata(
  path: string,
  metadata: OwnershipMetadata,
  afterOpen?: () => void | Promise<void>,
  beforePublish?: () => void | Promise<void>
): Promise<boolean> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    temporaryCreated = true;
    await afterOpen?.();
    await handle.writeFile(JSON.stringify(metadata), "utf8");
    await handle.close();
    handle = undefined;
    await beforePublish?.();
    await link(temporaryPath, path);
    await unlink(temporaryPath).catch(() => undefined);
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
    return false;
  }
}

async function updateMetadata(
  path: string,
  provisional: OwnershipMetadata,
  completed: OwnershipMetadata,
  beforeWrite?: () => void | Promise<void>
): Promise<boolean> {
  const current = await readMetadata(path);
  if (current.kind !== "valid" || !matchesMetadata(current.metadata, provisional)) {
    return false;
  }

  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryCreated = false;
  try {
    await beforeWrite?.();
    handle = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    temporaryCreated = true;
    await handle.writeFile(JSON.stringify(completed), "utf8");
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
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
  if (entry.isSymbolicLink() || !entry.isFile() || await realpath(path).catch(() => undefined) !== path) {
    return false;
  }
  return unlink(path).then(() => true).catch(() => false);
}

function matchesMetadata(current: OwnershipMetadata, expected: OwnershipMetadata): boolean {
  return current.investigationId === expected.investigationId &&
    current.sourceRepositoryPath === expected.sourceRepositoryPath &&
    current.worktreePath === expected.worktreePath &&
    current.creationComplete === expected.creationComplete;
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
