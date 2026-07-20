import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupIsolatedWorktree,
  prepareIsolatedWorktree,
  type WorktreeGitRunner
} from "../src/repository/index.js";
import { stageGeneratedTest } from "../src/runner/staging.js";

const run = promisify(execFile);
const directories: string[] = [];
const generatedTest = "import { expect, test } from '@playwright/test'; test('checkout', async ({ page }) => { await page.click('button'); await expect(true).toBe(true); });";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isolated worktrees", () => {
  it.runIf(process.platform !== "win32")("creates a private worktree that accepts generated-test staging", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "staging-private", { testRootPath: rootPath });

    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      return;
    }
    expect((await stat(prepared.worktreePath)).mode & 0o077).toBe(0);
    await expect(stageGeneratedTest(prepared.worktreePath, generatedTest)).resolves.toMatchObject({ status: "staged" });
    await expect(cleanupIsolatedWorktree(prepared.investigationId, { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
  });

  it.runIf(process.platform !== "win32")("rolls back a worktree when private permissions cannot be applied", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "permission-failure", {
      testRootPath: rootPath,
      testHooks: { beforeWorktreePermissions: () => { throw new Error("chmod failed"); } }
    })).resolves.toEqual({ status: "failed", failure: { code: "creation_failed" } });
    await expect(readdir(rootPath)).resolves.not.toContain("permission-failure");
    await expect(readdir(rootPath)).resolves.not.toContain("permission-failure.json");
  });

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
    await expect(run("git", ["-C", prepared.worktreePath, "symbolic-ref", "-q", "HEAD"])).rejects.toMatchObject({ code: 1 });
    await expect(run("git", ["-C", canonicalSourcePath, "status", "--porcelain"])).resolves.toMatchObject({ stdout: "" });
    await expect(readFile(join(canonicalRootPath, "investigation-24.json"), "utf8")).resolves.toContain('"creationComplete":true');

    await expect(cleanupIsolatedWorktree(prepared.investigationId, { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
    await expect(cleanupIsolatedWorktree(prepared.investigationId, { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
  });

  it("rejects unsafe, linked, and non-canonical source and root paths", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const victimPath = await createDirectory();
    const linkedRoot = join(rootPath, "linked-root");
    const intermediateRoot = join(rootPath, "intermediate", "worktrees");
    const linkedSource = join(rootPath, "linked-source");
    await createDirectoryLink(victimPath, linkedRoot);
    await createDirectoryLink(victimPath, join(rootPath, "intermediate"));
    await createDirectoryLink(sourceRepositoryPath, linkedSource);

    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "../escape", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "invalid_destination" }
    });
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "investigation-24", { testRootPath: linkedRoot })).resolves.toEqual({
      status: "failed", failure: { code: "invalid_destination" }
    });
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "investigation-24", { testRootPath: intermediateRoot })).resolves.toEqual({
      status: "failed", failure: { code: "invalid_destination" }
    });
    await expect(prepareIsolatedWorktree(linkedSource, "investigation-24", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "creation_failed" }
    });
    await expect(prepareIsolatedWorktree(`${sourceRepositoryPath}/../${basename(sourceRepositoryPath)}`, "investigation-24", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "creation_failed" }
    });
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "investigation-24", {
      testRootPath: `${rootPath}/../${basename(rootPath)}`
    })).resolves.toEqual({ status: "failed", failure: { code: "invalid_destination" } });
    await expect(readdir(victimPath)).resolves.toEqual([]);
  });

  it("uses the approved Windows application root and fails closed without LOCALAPPDATA", async () => {
    const sourceRepositoryPath = await createRepository();
    const localAppData = await createDirectory();
    const windowsOptions = {
      testHooks: { platform: "win32" as const, environment: { LOCALAPPDATA: localAppData } }
    };
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "windows-root", windowsOptions);
    expect(prepared).toMatchObject({
      status: "prepared",
      worktreePath: join(localAppData, "FailSpec", "worktrees", "windows-root")
    });
    await expect(cleanupIsolatedWorktree("windows-root", windowsOptions)).resolves.toEqual({ status: "cleaned" });
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "no-local-app-data", {
      testHooks: { platform: "win32" as const, environment: {} }
    })).resolves.toEqual({ status: "failed", failure: { code: "invalid_destination" } });
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "relative-local-app-data", {
      testHooks: { platform: "win32" as const, environment: { LOCALAPPDATA: "relative" } }
    })).resolves.toEqual({ status: "failed", failure: { code: "invalid_destination" } });

    const linkedLocalAppData = await createDirectory();
    await createDirectoryLink(await createDirectory(), join(linkedLocalAppData, "FailSpec"));
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "linked-application-path", {
      testHooks: { platform: "win32" as const, environment: { LOCALAPPDATA: linkedLocalAppData } }
    })).resolves.toEqual({ status: "failed", failure: { code: "invalid_destination" } });
  });

  it("normalizes Git paths and CRLF porcelain output before ownership comparison", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    let preparedPath = "";
    const runner: WorktreeGitRunner = {
      run: async (cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: `${canonicalSourcePath.replaceAll("/", "\\")}\r\n` };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { kind: "completed", exitCode: 0, output: `worktree ${preparedPath.replaceAll("/", "\\")}\r\n\r\n` };
        }
        await run("git", ["-C", cwd, ...args]);
        return { kind: "completed", exitCode: 0, output: "" };
      }
    };
    const options = { testRootPath: rootPath, gitRunner: runner, testHooks: { platform: "win32" as const } };
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "path-normalization", options);
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    preparedPath = prepared.worktreePath;
    await expect(cleanupIsolatedWorktree("path-normalization", options)).resolves.toEqual({ status: "cleaned" });
  });

  it("returns typed Git failures and safely recovers a recorded partial creation", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const timeoutRunner: WorktreeGitRunner = { run: async () => ({ kind: "timeout" }) };
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "timeout", { testRootPath: rootPath, gitRunner: timeoutRunner })).resolves.toEqual({
      status: "failed", failure: { code: "creation_failed" }
    });
    const outputLimitRunner: WorktreeGitRunner = { run: async () => ({ kind: "output_limit" }) };
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "output-limit", { testRootPath: rootPath, gitRunner: outputLimitRunner })).resolves.toEqual({
      status: "failed", failure: { code: "creation_failed" }
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
      status: "failed", failure: { code: "creation_failed" }
    });
    await expect(cleanupIsolatedWorktree("partial", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
  });

  it("recovers after a deterministic metadata-update failure and refuses unowned cleanup", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const options = { testRootPath: rootPath, testHooks: { beforeMetadataUpdate: () => { throw new Error("injected failure"); } } };
    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "marker-failure", options)).resolves.toEqual({
      status: "failed", failure: { code: "metadata_failed" }
    });
    await expect(readFile(join(rootPath, "marker-failure.json"), "utf8")).resolves.toContain('"creationComplete":false');
    await expect(cleanupIsolatedWorktree("marker-failure", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });

    await mkdir(join(rootPath, "unowned"));
    await expect(cleanupIsolatedWorktree("unowned", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });
  });

  it("does not delete a completed worktree when Git reports removal without removing it", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    let worktreePath = "";
    const runner: WorktreeGitRunner = {
      run: async (cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: canonicalSourcePath };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { kind: "completed", exitCode: 0, output: `worktree ${worktreePath}\n` };
        }
        if (args[0] === "worktree" && args[1] === "remove") {
          return { kind: "completed", exitCode: 0, output: "" };
        }
        await run("git", ["-C", cwd, ...args]);
        return { kind: "completed", exitCode: 0, output: "" };
      }
    };
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "completed-remains", { testRootPath: rootPath, gitRunner: runner });
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    worktreePath = prepared.worktreePath;
    await expect(cleanupIsolatedWorktree("completed-remains", { testRootPath: rootPath, gitRunner: runner })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });
    await expect(readdir(worktreePath)).resolves.toEqual(expect.any(Array));
  });

  it("revalidates metadata before partial recursive deletion", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const partialRunner: WorktreeGitRunner = {
      run: async (cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: canonicalSourcePath };
        }
        await run("git", ["-C", cwd, ...args]);
        await run("git", ["-C", cwd, "worktree", "remove", "--force", args[3] ?? ""]);
        await mkdir(args[3] ?? "");
        return { kind: "completed", exitCode: 1, output: "" };
      }
    };
    await prepareIsolatedWorktree(sourceRepositoryPath, "tampered-partial", { testRootPath: rootPath, gitRunner: partialRunner });
    await expect(cleanupIsolatedWorktree("tampered-partial", {
      testRootPath: rootPath,
      testHooks: { beforePartialCleanup: () => writeFile(join(rootPath, "tampered-partial.json"), "{}", "utf8") }
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    await expect(readdir(join(rootPath, "tampered-partial"))).resolves.toEqual(expect.any(Array));
  });

  it("rejects unsafe metadata states and cleans valid metadata whose destination is already gone", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    await writeFile(join(rootPath, "malformed.json"), "{}", "utf8");
    await expect(cleanupIsolatedWorktree("malformed", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });
    const victimPath = await createDirectory();
    await createDirectoryLink(victimPath, join(rootPath, "metadata-link.json"));
    await expect(cleanupIsolatedWorktree("metadata-link", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });

    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "already-removed", { testRootPath: rootPath });
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    await run("git", ["-C", sourceRepositoryPath, "worktree", "remove", "--force", prepared.worktreePath]);
    await expect(cleanupIsolatedWorktree("already-removed", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
  });

  it("rejects linked metadata even when the external target is valid", async () => {
    if (process.platform === "win32") {
      return;
    }
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const externalMetadataPath = join(await createDirectory(), "metadata.json");
    await writeFile(externalMetadataPath, JSON.stringify({
      investigationId: "linked-valid",
      sourceRepositoryPath,
      worktreePath: join(rootPath, "linked-valid"),
      creationComplete: true
    }), "utf8");
    await symlink(externalMetadataPath, join(rootPath, "linked-valid.json"), "file");

    await expect(cleanupIsolatedWorktree("linked-valid", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });
  });

  it("rejects unsafe existing POSIX roots and non-canonical metadata sources", async () => {
    const sourceRepositoryPath = await createRepository();
    if (process.platform !== "win32") {
      const unsafeRootPath = await createDirectory();
      await chmod(unsafeRootPath, 0o777);
      await expect(prepareIsolatedWorktree(sourceRepositoryPath, "unsafe-root", { testRootPath: unsafeRootPath })).resolves.toEqual({
        status: "failed", failure: { code: "invalid_destination" }
      });
    }

    const rootPath = await createDirectory();
    await writeFile(join(rootPath, "noncanonical-source.json"), JSON.stringify({
      investigationId: "noncanonical-source",
      sourceRepositoryPath: `${sourceRepositoryPath}/../${basename(sourceRepositoryPath)}`,
      worktreePath: join(rootPath, "noncanonical-source"),
      creationComplete: true
    }), "utf8");
    await expect(cleanupIsolatedWorktree("noncanonical-source", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });
  });
});

async function createDirectoryLink(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

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
