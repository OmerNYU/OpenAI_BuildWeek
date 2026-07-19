import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupIsolatedWorktree,
  prepareIsolatedWorktree,
  type WorktreeGitResult,
  type WorktreeGitRunner
} from "../src/repository/index.js";
import { prepareIsolatedWorktreeAttempt } from "../src/repository/worktree/index.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isolated worktrees", () => {
  it("uses a generated destination, lets Git create it, and cleans through the stored path", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalRootPath = await realpath(rootPath);
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "investigation-24", {
      testRootPath: rootPath,
      testHooks: { generateDestinationSuffix: () => "deterministic-uuid" }
    });

    expect(prepared).toMatchObject({
      status: "prepared",
      investigationId: "investigation-24",
      worktreePath: join(canonicalRootPath, "investigation-24-deterministic-uuid")
    });
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    await expect(run("git", ["-C", prepared.worktreePath, "symbolic-ref", "-q", "HEAD"])).rejects.toMatchObject({ code: 1 });
    await expect(readFile(join(canonicalRootPath, "investigation-24.json"), "utf8")).resolves.toContain(
      '"worktreePath":"' + prepared.worktreePath.replaceAll("\\", "\\\\") + '"'
    );
    await expect(readFile(join(canonicalRootPath, "investigation-24.json"), "utf8")).resolves.toContain(
      '"creationComplete":true'
    );

    await expect(cleanupIsolatedWorktree("investigation-24", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
    await expect(lstat(prepared.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(canonicalRootPath, "investigation-24.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not create the generated destination before invoking Git", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    let destinationPath = "";
    const runner: WorktreeGitRunner = {
      run: async (_cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: canonicalSourcePath };
        }
        if (args[0] === "worktree" && args[1] === "add") {
          destinationPath = args[3] as string;
          await expect(lstat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
          await mkdir(destinationPath);
          return { kind: "completed", exitCode: 0, output: "" };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { kind: "completed", exitCode: 0, output: `worktree ${destinationPath}\n` };
        }
        if (args[0] === "worktree" && args[1] === "remove") {
          await rm(destinationPath, { recursive: true, force: true });
          return { kind: "completed", exitCode: 0, output: "" };
        }
        return { kind: "failed" };
      }
    };

    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "created-by-git", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: { generateDestinationSuffix: () => "test-random-component" }
    });

    expect(prepared).toMatchObject({
      status: "prepared",
      worktreePath: join(await realpath(rootPath), "created-by-git-test-random-component")
    });
  });

  it("rejects a collision at the generated destination before invoking Git", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const destinationPath = join(rootPath, "collision-fixed-component");
    await mkdir(destinationPath);
    await writeFile(join(destinationPath, "sentinel.txt"), "foreign", "utf8");
    const runner: WorktreeGitRunner & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn()
    };

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "collision", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    })).resolves.toEqual({
      status: "failed", failure: "invalid_destination", cleanupAuthorized: false
    });
    expect(runner.run).not.toHaveBeenCalled();
    await expect(readFile(join(destinationPath, "sentinel.txt"), "utf8")).resolves.toBe("foreign");
  });

  it("requires successful Git add to be positively listed before completing metadata", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const destinationPath = join(rootPath, "unlisted-success-fixed-component");
    const runner = fakeRunner(canonicalSourcePath, async (args) => {
      if (args[1] === "add") {
        await mkdir(destinationPath);
        return { kind: "completed" as const, exitCode: 0, output: "" };
      }
      if (args[1] === "list") {
        return { kind: "completed" as const, exitCode: 0, output: "" };
      }
      return { kind: "failed" as const };
    });

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "unlisted-success", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    await expect(lstat(destinationPath)).resolves.toBeDefined();
    await expectProvisionalMetadata(rootPath, "unlisted-success", destinationPath);
  });

  it("keeps provisional metadata when a failed Git add creates no recognized worktree", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const runner = fakeRunner(canonicalSourcePath, async (args) => args[1] === "add"
      ? { kind: "completed" as const, exitCode: 1, output: "" }
      : { kind: "completed" as const, exitCode: 0, output: "" });

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "failed-no-worktree", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    await expectProvisionalMetadata(
      rootPath,
      "failed-no-worktree",
      join(rootPath, "failed-no-worktree-fixed-component")
    );
  });

  it("queries Git recognition after failed, timed-out, output-limited, and thrown Git adds", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const outcomes: Array<WorktreeGitResult | "throw"> = [
      { kind: "failed" },
      { kind: "timeout" },
      { kind: "output_limit" },
      "throw"
    ];

    for (const [index, outcome] of outcomes.entries()) {
      const investigationId = `failed-mode-${index}`;
      let listCalls = 0;
      const runner = fakeRunner(canonicalSourcePath, async (args) => {
        if (args[1] === "add") {
          if (outcome === "throw") {
            throw new Error("runner error");
          }
          return outcome;
        }
        if (args[1] === "list") {
          listCalls += 1;
          return { kind: "completed", exitCode: 0, output: "" };
        }
        return { kind: "failed" as const };
      });

      await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
        testRootPath: rootPath,
        gitRunner: runner,
        testHooks: { generateDestinationSuffix: () => `fixed-component-${index}` }
      })).resolves.toEqual({
        status: "failed", failure: "creation_failed", cleanupAuthorized: true
      });
      expect(listCalls).toBe(1);
      await expectProvisionalMetadata(
        rootPath,
        investigationId,
        join(rootPath, `${investigationId}-fixed-component-${index}`)
      );
    }
  });

  it("rolls back a Git-recognized failed add through Git and keeps provisional metadata", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const destinationPath = join(rootPath, "failed-recognized-fixed-component");
    let removedThroughGit = false;
    const runner = fakeRunner(canonicalSourcePath, async (args) => {
      if (args[1] === "add") {
        await mkdir(destinationPath);
        return { kind: "completed" as const, exitCode: 1, output: "" };
      }
      if (args[1] === "list") {
        return { kind: "completed" as const, exitCode: 0, output: `worktree ${destinationPath}\n` };
      }
      if (args[1] === "remove") {
        removedThroughGit = true;
        await rm(destinationPath, { recursive: true, force: true });
        return { kind: "completed" as const, exitCode: 0, output: "" };
      }
      return { kind: "failed" as const };
    });

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "failed-recognized", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    expect(removedThroughGit).toBe(true);
    await expect(lstat(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectProvisionalMetadata(rootPath, "failed-recognized", destinationPath);
  });

  it("preserves an unrecognized destination left by a failed Git add", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const destinationPath = join(rootPath, "failed-unrecognized-fixed-component");
    const sentinelPath = join(destinationPath, "sentinel.txt");
    const runner = fakeRunner(canonicalSourcePath, async (args) => {
      if (args[1] === "add") {
        await mkdir(destinationPath);
        await writeFile(sentinelPath, "preserve", "utf8");
        return { kind: "completed" as const, exitCode: 1, output: "" };
      }
      return { kind: "completed" as const, exitCode: 0, output: "" };
    });

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "failed-unrecognized", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("preserve");
    await expectProvisionalMetadata(rootPath, "failed-unrecognized", destinationPath);
    await expect(cleanupIsolatedWorktree("failed-unrecognized", {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("preserve");
  });

  it("preserves provisional metadata when completion update and Git rollback both fail", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const destinationPath = join(rootPath, "metadata-failure-fixed-component");
    let removedThroughGit = false;
    const runner = fakeRunner(canonicalSourcePath, async (args) => {
      if (args[1] === "add") {
        await mkdir(destinationPath);
        return { kind: "completed" as const, exitCode: 0, output: "" };
      }
      if (args[1] === "list") {
        return { kind: "completed" as const, exitCode: 0, output: `worktree ${destinationPath}\n` };
      }
      if (args[1] === "remove") {
        removedThroughGit = true;
        return { kind: "completed" as const, exitCode: 1, output: "" };
      }
      return { kind: "failed" as const };
    });

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "metadata-failure", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: {
        generateDestinationSuffix: () => "fixed-component",
        beforeMetadataUpdate: () => { throw new Error("injected metadata failure"); }
      }
    })).resolves.toEqual({
      status: "failed", failure: "metadata_failed", cleanupAuthorized: true
    });
    expect(removedThroughGit).toBe(true);
    await expect(lstat(destinationPath)).resolves.toBeDefined();
    await expectProvisionalMetadata(rootPath, "metadata-failure", destinationPath);
  });

  it("keeps provisional metadata when a recognized failed add cannot be rolled back", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const destinationPath = join(rootPath, "failed-rollback-fixed-component");
    let removeCalls = 0;
    const runner = fakeRunner(canonicalSourcePath, async (args) => {
      if (args[1] === "add") {
        await mkdir(destinationPath);
        return { kind: "completed" as const, exitCode: 1, output: "" };
      }
      if (args[1] === "list") {
        return { kind: "completed" as const, exitCode: 0, output: `worktree ${destinationPath}\n` };
      }
      if (args[1] === "remove") {
        removeCalls += 1;
        return { kind: "completed" as const, exitCode: 1, output: "" };
      }
      return { kind: "failed" as const };
    });

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "failed-rollback", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    expect(removeCalls).toBe(1);
    await expect(lstat(destinationPath)).resolves.toBeDefined();
    await expectProvisionalMetadata(rootPath, "failed-rollback", destinationPath);
  });

  it("removes its unpublished initial-metadata temporary file after a write failure", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const runner: WorktreeGitRunner & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn()
    };

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "initial-open-failure", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: {
        generateDestinationSuffix: () => "fixed-component",
        afterInitialMetadataOpen: () => { throw new Error("injected initial write failure"); }
      }
    })).resolves.toEqual({
      status: "failed", failure: "metadata_failed", cleanupAuthorized: false
    });
    expect(runner.run).not.toHaveBeenCalled();
    await expect(lstat(join(rootPath, "initial-open-failure.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves a regular metadata replacement that appears before initial publication", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const metadataPath = join(rootPath, "initial-regular-replacement.json");
    const runner: WorktreeGitRunner & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn()
    };

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "initial-regular-replacement", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: {
        generateDestinationSuffix: () => "fixed-component",
        beforeInitialMetadataPublish: () => writeFile(metadataPath, "replacement", "utf8")
      }
    })).resolves.toEqual({
      status: "failed", failure: "metadata_failed", cleanupAuthorized: false
    });

    expect(runner.run).not.toHaveBeenCalled();
    await expect(readFile(metadataPath, "utf8")).resolves.toBe("replacement");
    await expect(readdir(rootPath)).resolves.toEqual(["initial-regular-replacement.json"]);
  });

  it("preserves a symlink metadata replacement and its external target before initial publication", async () => {
    if (process.platform === "win32") {
      return;
    }

    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const externalPath = join(await createDirectory(), "external-metadata.json");
    const metadataPath = join(rootPath, "initial-symlink-replacement.json");
    const runner: WorktreeGitRunner & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn()
    };
    await writeFile(externalPath, "external", "utf8");

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "initial-symlink-replacement", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: {
        generateDestinationSuffix: () => "fixed-component",
        beforeInitialMetadataPublish: () => symlink(externalPath, metadataPath, "file")
      }
    })).resolves.toEqual({
      status: "failed", failure: "metadata_failed", cleanupAuthorized: false
    });

    expect(runner.run).not.toHaveBeenCalled();
    expect((await lstat(metadataPath)).isSymbolicLink()).toBe(true);
    await expect(readFile(externalPath, "utf8")).resolves.toBe("external");
  });

  it("publishes complete provisional metadata before Git begins", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const metadataPath = join(rootPath, "published-provisional.json");
    const destinationPath = join(rootPath, "published-provisional-fixed-component");
    let observedProvisionalMetadata = false;
    const runner: WorktreeGitRunner = {
      run: async (_cwd, args) => {
        if (args[0] === "rev-parse") {
          await expect(readFile(metadataPath, "utf8")).resolves.toBe(JSON.stringify({
            investigationId: "published-provisional",
            sourceRepositoryPath: canonicalSourcePath,
            worktreePath: destinationPath,
            creationComplete: false
          }));
          observedProvisionalMetadata = true;
          return { kind: "completed", exitCode: 0, output: canonicalSourcePath };
        }
        return { kind: "completed", exitCode: 1, output: "" };
      }
    };

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "published-provisional", {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });

    expect(observedProvisionalMetadata).toBe(true);
  });

  it("preserves a Git-unrecognized cleanup destination and its metadata", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "cleanup-unrecognized", {
      testRootPath: rootPath,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    });
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    const sentinelPath = join(prepared.worktreePath, "sentinel.txt");
    await writeFile(sentinelPath, "preserve", "utf8");
    const runner: WorktreeGitRunner & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn(async () => ({ kind: "completed" as const, exitCode: 0, output: "" }))
    };

    await expect(cleanupIsolatedWorktree("cleanup-unrecognized", {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    expect(runner.run).toHaveBeenCalledTimes(1);
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("preserve");
    await expect(readFile(join(rootPath, "cleanup-unrecognized.json"), "utf8")).resolves.toContain('"worktreePath"');
  });

  it("removes valid metadata when its generated destination is already absent", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "already-removed", {
      testRootPath: rootPath,
      testHooks: { generateDestinationSuffix: () => "fixed-component" }
    });
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    await run("git", ["-C", sourceRepositoryPath, "worktree", "remove", "--force", prepared.worktreePath]);

    await expect(cleanupIsolatedWorktree("already-removed", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
    await expect(lstat(join(rootPath, "already-removed.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for malformed, linked, and escaped ownership metadata", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    await writeFile(join(rootPath, "malformed.json"), "{}", "utf8");
    await expect(cleanupIsolatedWorktree("malformed", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });

    if (process.platform !== "win32") {
      const externalMetadataPath = join(await createDirectory(), "metadata.json");
      await writeFile(externalMetadataPath, "{}", "utf8");
      await symlink(externalMetadataPath, join(rootPath, "linked.json"), "file");
      await expect(cleanupIsolatedWorktree("linked", { testRootPath: rootPath })).resolves.toEqual({
        status: "failed", failure: { code: "cleanup_failed" }
      });
    }

    await writeFile(join(rootPath, "escaped.json"), JSON.stringify({
      investigationId: "escaped",
      sourceRepositoryPath,
      worktreePath: join(await createDirectory(), "escaped-fixed-component"),
      creationComplete: true
    }), "utf8");
    await expect(cleanupIsolatedWorktree("escaped", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });
  });

  it("rejects unsafe roots and linked sources without creating a worktree", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const victimPath = await createDirectory();
    const linkedRoot = join(rootPath, "linked-root");
    const linkedSource = join(rootPath, "linked-source");
    await createDirectoryLink(victimPath, linkedRoot);
    await createDirectoryLink(sourceRepositoryPath, linkedSource);

    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "safe-id", { testRootPath: linkedRoot })).resolves.toEqual({
      status: "failed", failure: { code: "invalid_destination" }
    });
    await expect(prepareIsolatedWorktree(linkedSource, "safe-id", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "creation_failed" }
    });
    if (process.platform !== "win32") {
      const unsafeRootPath = await createDirectory();
      await chmod(unsafeRootPath, 0o777);
      await expect(prepareIsolatedWorktree(sourceRepositoryPath, "safe-id", { testRootPath: unsafeRootPath })).resolves.toEqual({
        status: "failed", failure: { code: "invalid_destination" }
      });
    }
  });

  it("normalizes CRLF Git porcelain paths before recognizing a generated worktree", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const destinationPath = join(rootPath, "normalized-fixed-component");
    const runner = fakeRunner(canonicalSourcePath, async (args) => {
      if (args[1] === "add") {
        await mkdir(destinationPath);
        return { kind: "completed" as const, exitCode: 0, output: "" };
      }
      if (args[1] === "list") {
        return { kind: "completed" as const, exitCode: 0, output: `worktree ${destinationPath.replaceAll("/", "\\")}\r\n\r\n` };
      }
      if (args[1] === "remove") {
        await rm(destinationPath, { recursive: true, force: true });
        return { kind: "completed" as const, exitCode: 0, output: "" };
      }
      return { kind: "failed" as const };
    });
    const options = {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: {
        platform: "win32" as const,
        generateDestinationSuffix: () => "fixed-component"
      }
    };

    await expect(prepareIsolatedWorktree(sourceRepositoryPath, "normalized", options)).resolves.toMatchObject({
      status: "prepared", worktreePath: destinationPath
    });
    await expect(cleanupIsolatedWorktree("normalized", options)).resolves.toEqual({ status: "cleaned" });
  });
});

async function expectProvisionalMetadata(
  rootPath: string,
  investigationId: string,
  worktreePath: string
): Promise<void> {
  const metadata = JSON.parse(await readFile(join(rootPath, `${investigationId}.json`), "utf8")) as {
    worktreePath: string;
    creationComplete: boolean;
  };
  expect(metadata).toMatchObject({ worktreePath, creationComplete: false });
}

function fakeRunner(
  canonicalSourcePath: string,
  handleWorktree: (args: readonly string[]) => Promise<WorktreeGitResult>
): WorktreeGitRunner {
  return {
    run: async (_cwd, args) => args[0] === "rev-parse"
      ? { kind: "completed", exitCode: 0, output: canonicalSourcePath }
      : handleWorktree(args)
  };
}

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
