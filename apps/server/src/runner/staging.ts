import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { GeneratedTestStagingResult } from "@failspec/contracts";
import {
  generatedTestCapabilities,
  stagedGeneratedTestPath,
  validateGeneratedTestSource
} from "../generated-test/index.js";

export { generatedTestCapabilities, stagedGeneratedTestPath };

export async function stageGeneratedTest(
  worktreePath: string,
  content: string
): Promise<GeneratedTestStagingResult> {
  const validation = validateGeneratedTestSource(content);
  if (!validation.valid) {
    return rejected(validation.failure);
  }

  const root = await canonicalDirectory(worktreePath);
  if (!root || !(await isPrivateWorktree(root))) {
    return failed("write_failed");
  }
  try {
    const testsDirectory = await ownedDirectory(root, "tests");
    const destinationDirectory = testsDirectory && await ownedDirectory(testsDirectory, "generated");
    if (!destinationDirectory) {
      return failed("write_failed");
    }
    const destination = join(destinationDirectory, basename(stagedGeneratedTestPath));
    const handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    let created: Awaited<ReturnType<typeof handle.stat>> | undefined;
    let staged = false;
    try {
      created = await handle.stat();
      const resolvedDestination = await realpath(destination);
      const current = await stat(destination);
      if (resolvedDestination !== destination || created.dev !== current.dev || created.ino !== current.ino) {
        return failed("write_failed");
      }
      await handle.writeFile(content, "utf8");
      staged = true;
      return { status: "staged", stagedTestPath: stagedGeneratedTestPath };
    } finally {
      await handle.close();
      if (!staged && created) {
        await removeCreatedFile(destination, created);
      }
    }
  } catch {
    return failed("write_failed");
  }
}

async function ownedDirectory(parent: string, name: string): Promise<string | undefined> {
  const path = join(parent, name);
  let entry = await lstat(path).catch(() => undefined);
  if (!entry) {
    await mkdir(path);
    entry = await lstat(path);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    return undefined;
  }
  const canonicalPath = await realpath(path);
  return isInside(parent, canonicalPath) ? canonicalPath : undefined;
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const canonicalPath = await realpath(path);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function isPrivateWorktree(root: string): Promise<boolean> {
  if (process.platform === "win32") {
    return true;
  }
  const owner = process.getuid?.();
  const entry = await stat(root);
  return owner !== undefined && entry.uid === owner && (entry.mode & 0o077) === 0;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

async function removeCreatedFile(path: string, created: { dev: number | bigint; ino: number | bigint }): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.dev === created.dev && current.ino === created.ino) {
      await unlink(path);
    }
  } catch {
    // The failed staging result is already sanitized; never remove a replacement.
  }
}

function rejected(code: "invalid_encoding" | "file_too_large" | "typescript_parse_failed" | "disallowed_import" | "disallowed_api") {
  return { status: "rejected" as const, failure: { code } };
}

function failed(code: "write_failed") {
  return { status: "failed" as const, failure: { code } };
}
