import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupIsolatedWorktree,
  prepareIsolatedWorktree,
  type WorktreeGitRunner
} from "../src/repository/index.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isolated worktrees", () => {
  it("creates a detached worktree from committed HEAD and cleans it without changing the source", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "investigation-24", { testRootPath: rootPath });
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const canonicalRootPath = await realpath(rootPath);

    expect(prepared).toMatchObject({
      status: "prepared",
      investigationId: "investigation-24",
      sourceRepositoryPath: canonicalSourcePath,
      worktreePath: join(canonicalRootPath, "investigation-24")
    });
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    await expect(run("git", ["-C", prepared.worktreePath, "symbolic-ref", "-q", "HEAD"])).rejects.toMatchObject({
      code: 1
    });
    await expect(run("git", ["-C", canonicalSourcePath, "status", "--porcelain"])).resolves.toMatchObject({ stdout: "" });
    await expect(readFile(join(canonicalRootPath, "investigation-24.json"), "utf8")).resolves.toContain('"creationComplete":true');

    await expect(cleanupIsolatedWorktree(prepared.investigationId, { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
    await expect(cleanupIsolatedWorktree(prepared.investigationId, { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
  });

  it("rejects unsafe, symlinked, and non-canonical source and root paths", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const victimPath = await createDirectory();
    const linkedRoot = join(rootPath, "linked-root");
    const intermediateRoot = join(rootPath, "intermediate", "worktrees");
    const linkedSource = join(rootPath, "linked-source");
    await symlink(victimPath, linkedRoot);
    await symlink(victimPath, join(rootPath, "intermediate"));
    await symlink(sourceRepositoryPath, linkedSource);

    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "../escape", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed",
      failure: { code: "invalid_destination" }
    });
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "investigation-24", { testRootPath: linkedRoot })).resolves.toEqual({
      status: "failed",
      failure: { code: "invalid_destination" }
    });
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "investigation-24", { testRootPath: intermediateRoot })).resolves.toEqual({
      status: "failed",
      failure: { code: "invalid_destination" }
    });
    await expect(prepareIsolatedWorktree(linkedSource, "investigation-24", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed",
      failure: { code: "creation_failed" }
    });
    await expect(prepareIsolatedWorktree(`${sourceRepositoryPath}/../${basename(sourceRepositoryPath)}`, "investigation-24", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed",
      failure: { code: "creation_failed" }
    });
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "investigation-24", {
      testRootPath: `${rootPath}/../${basename(rootPath)}`
    })).resolves.toEqual({
      status: "failed",
      failure: { code: "invalid_destination" }
    });
    await expect(readdir(victimPath)).resolves.toEqual([]);
  });

  it("returns typed failures for Git timeout and recorded partial creation cleanup", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const timeoutRunner: WorktreeGitRunner = { run: async () => ({ kind: "timeout" }) };
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "timeout", { testRootPath: rootPath, gitRunner: timeoutRunner })).resolves.toEqual({
      status: "failed",
      failure: { code: "creation_failed" }
    });
    const outputLimitRunner: WorktreeGitRunner = { run: async () => ({ kind: "output_limit" }) };
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "output-limit", { testRootPath: rootPath, gitRunner: outputLimitRunner })).resolves.toEqual({
      status: "failed",
      failure: { code: "creation_failed" }
    });

    const partialRunner: WorktreeGitRunner = {
      run: async (cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: `${canonicalSourcePath}\n` };
        }
        await run("git", ["-C", cwd, ...args]);
        return { kind: "completed", exitCode: 1, output: "" };
      }
    };
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "partial", { testRootPath: rootPath, gitRunner: partialRunner })).resolves.toEqual({
      status: "failed",
      failure: { code: "creation_failed" }
    });
    await expect(cleanupIsolatedWorktree("partial", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
  });

  it("recovers after a final metadata-write failure and refuses cleanup of an unowned destination", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalRootPath = await realpath(rootPath);
    const markerFailureRunner: WorktreeGitRunner = {
      run: async (cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: `${sourceRepositoryPath}\n` };
        }
        await run("git", ["-C", cwd, ...args]);
        await chmod(canonicalRootPath, 0o500);
        return { kind: "completed", exitCode: 0, output: "" };
      }
    };
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "marker-failure", { testRootPath: rootPath, gitRunner: markerFailureRunner })).resolves.toEqual({
      status: "failed",
      failure: { code: "metadata_failed" }
    });
    await expect(readFile(join(canonicalRootPath, "marker-failure.json"), "utf8")).resolves.toContain('"creationComplete":false');
    await chmod(canonicalRootPath, 0o700);
    await expect(cleanupIsolatedWorktree("marker-failure", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });

    await mkdir(join(canonicalRootPath, "unowned"));
    await expect(cleanupIsolatedWorktree("unowned", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed",
      failure: { code: "cleanup_failed" }
    });
  });

  it("rejects an unsafe existing root and metadata with a non-canonical source", async () => {
    const sourceRepositoryPath = await createRepository();
    const unsafeRootPath = await createDirectory();
    await chmod(unsafeRootPath, 0o777);
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "unsafe-root", { testRootPath: unsafeRootPath })).resolves.toEqual({
      status: "failed",
      failure: { code: "invalid_destination" }
    });

    const rootPath = await createDirectory();
    await mkdir(join(rootPath, "noncanonical-source"));
    await writeFile(join(rootPath, "noncanonical-source.json"), JSON.stringify({
      investigationId: "noncanonical-source",
      sourceRepositoryPath: `${sourceRepositoryPath}/../${basename(sourceRepositoryPath)}`,
      worktreePath: join(rootPath, "noncanonical-source"),
      creationComplete: true
    }), "utf8");
    await expect(cleanupIsolatedWorktree("noncanonical-source", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed",
      failure: { code: "cleanup_failed" }
    });
  });

  it("rejects a metadata symlink without reading through it", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const victimPath = await createDirectory();
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "metadata-link", { testRootPath: rootPath });
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    const metadataPath = join(rootPath, "metadata-link.json");
    await rm(metadataPath);
    await symlink(join(victimPath, "metadata.json"), metadataPath);

    await expect(cleanupIsolatedWorktree("metadata-link", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed",
      failure: { code: "cleanup_failed" }
    });
    await expect(readdir(victimPath)).resolves.toEqual([]);
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "failspec-worktree-"));
  directories.push(directory);
  return realpath(directory);
}

async function createRepository(): Promise<string> {
  const directory = await createDirectory();
  await writeFile(join(directory, "package.json"), "{}", "utf8");
  await run("git", ["init", directory]);
  await run("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", directory, "config", "user.name", "Test User"]);
  await run("git", ["-C", directory, "add", "."]);
  await run("git", ["-C", directory, "commit", "-m", "initial"]);
  return directory;
}
