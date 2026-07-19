import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupIsolatedWorktree,
  prepareIsolatedWorktree,
  type WorktreeGitRunner
} from "../src/repository/index.js";
import { prepareIsolatedWorktreeAttempt } from "../src/repository/worktree/index.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("isolated worktrees", () => {
  it("creates a detached worktree in a reserved empty destination and cleans it without changing the source", async () => {
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

  it("authorizes rollback only after this invocation creates ownership metadata", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const existingDestination = join(rootPath, "existing-destination");
    await mkdir(existingDestination);
    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "existing-destination", {
      testRootPath: rootPath
    })).resolves.toEqual({
      status: "failed",
      failure: "invalid_destination",
      cleanupAuthorized: false
    });

    await writeFile(join(rootPath, "existing-record.json"), "{}", "utf8");
    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "existing-record", {
      testRootPath: rootPath
    })).resolves.toEqual({
      status: "failed",
      failure: "invalid_destination",
      cleanupAuthorized: false
    });

    const beforeMetadataRunner: WorktreeGitRunner = { run: async () => ({ kind: "timeout" }) };
    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "before-metadata", {
      testRootPath: rootPath,
      gitRunner: beforeMetadataRunner
    })).resolves.toEqual({
      status: "failed",
      failure: "creation_failed",
      cleanupAuthorized: false
    });
  });

  it("does not overwrite a destination that wins the atomic reservation race", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const investigationId = "race-loss";
    const destinationPath = join(rootPath, investigationId);
    const sentinelPath = join(destinationPath, "sentinel.txt");
    await mkdir(destinationPath);
    await writeFile(sentinelPath, "foreign directory", "utf8");

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
      testRootPath: rootPath
    })).resolves.toEqual({
      status: "failed",
      failure: "invalid_destination",
      cleanupAuthorized: false
    });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("foreign directory");
    await expect(readFile(join(rootPath, `${investigationId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not recursively remove a reservation when initial metadata writing fails", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const investigationId = "initial-metadata-failure";
    const sentinelPath = join(rootPath, investigationId, "sentinel.txt");

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
      testRootPath: rootPath,
      testHooks: {
        beforeInitialMetadataWrite: async () => {
          await writeFile(sentinelPath, "preserve this", "utf8");
          throw new Error("metadata failure");
        }
      }
    })).resolves.toEqual({
      status: "failed",
      failure: "metadata_failed",
      cleanupAuthorized: false
    });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("preserve this");
    await expect(readFile(join(rootPath, `${investigationId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not remove an empty replacement when initial metadata writing fails", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const investigationId = "initial-metadata-replacement";
    const destinationPath = join(rootPath, investigationId);

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
      testRootPath: rootPath,
      testHooks: {
        beforeInitialMetadataWrite: async () => {
          await rm(destinationPath, { recursive: true, force: true });
          await mkdir(destinationPath);
          throw new Error("metadata failure");
        }
      }
    })).resolves.toEqual({
      status: "failed",
      failure: "metadata_failed",
      cleanupAuthorized: false
    });
    await expect(readdir(destinationPath)).resolves.toEqual([]);
    await expect(readFile(join(rootPath, `${investigationId}.json`), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not invoke Git when the reserved destination is replaced after identity capture", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const investigationId = "replacement-before-git";
    const destinationPath = join(rootPath, investigationId);
    const runner: WorktreeGitRunner & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn(async (_cwd, args) => args[0] === "rev-parse"
        ? { kind: "completed" as const, exitCode: 0, output: canonicalSourcePath }
        : { kind: "completed" as const, exitCode: 0, output: "" })
    };

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: {
        beforeGitWorktreeAdd: async () => {
          await rm(destinationPath, { recursive: true, force: true });
          await mkdir(destinationPath);
        }
      }
    })).resolves.toEqual({
      status: "failed",
      failure: "creation_failed",
      cleanupAuthorized: true
    });
    expect(runner.run).toHaveBeenCalledTimes(1);
    await expect(readdir(destinationPath)).resolves.toEqual([]);
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

  it("returns typed Git failures and removes metadata only when the destination is absent", async () => {
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
    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "partial", {
      testRootPath: rootPath,
      gitRunner: partialRunner
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    await expect(cleanupIsolatedWorktree("partial", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
    await expect(readFile(join(rootPath, "partial.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const throwingRunner: WorktreeGitRunner = {
      run: async (_cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: `${canonicalSourcePath}\n` };
        }
        throw new Error("worktree add failed unexpectedly");
      }
    };
    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "thrown-add", {
      testRootPath: rootPath,
      gitRunner: throwingRunner
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    await expect(cleanupIsolatedWorktree("thrown-add", { testRootPath: rootPath })).resolves.toEqual({
      status: "failed", failure: { code: "cleanup_failed" }
    });
    await expect(readFile(join(rootPath, "thrown-add.json"), "utf8")).resolves.toContain('"creationComplete":false');
  });

  it("recovers after a deterministic metadata-update failure and refuses unowned cleanup", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const options = { testRootPath: rootPath, testHooks: { beforeMetadataUpdate: () => { throw new Error("injected failure"); } } };
    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, "marker-failure", options)).resolves.toEqual({
      status: "failed", failure: "metadata_failed", cleanupAuthorized: true
    });
    await expect(readFile(join(rootPath, "marker-failure.json"), "utf8")).resolves.toContain('"creationComplete":false');
    await expect(cleanupIsolatedWorktree("marker-failure", { testRootPath: rootPath })).resolves.toEqual({ status: "cleaned" });
    await expect(readFile(join(rootPath, "marker-failure.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

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

  it("preserves an unrecognized partial destination after a failed worktree add", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const investigationId = "reserved-partial";
    const sentinelPath = join(rootPath, investigationId, "sentinel.txt");
    const runner: WorktreeGitRunner = {
      run: async (cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: canonicalSourcePath };
        }
        if (args[0] === "worktree" && args[1] === "add") {
          await writeFile(sentinelPath, "do not remove", "utf8");
          return { kind: "completed", exitCode: 1, output: "" };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { kind: "completed", exitCode: 0, output: "" };
        }
        return { kind: "failed" };
      }
    };
    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });

    await expect(cleanupIsolatedWorktree(investigationId, {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("do not remove");
    await expect(readFile(join(rootPath, `${investigationId}.json`), "utf8")).resolves.toContain('"creationComplete":false');
  });

  it("does not invoke Git cleanup for a replaced completed worktree destination", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const prepared = await prepareIsolatedWorktree(sourceRepositoryPath, "completed-replaced", {
      testRootPath: rootPath
    });
    if (prepared.status !== "prepared") {
      throw new Error("Expected a prepared worktree.");
    }
    const sentinelPath = join(prepared.worktreePath, "sentinel.txt");
    await rm(prepared.worktreePath, { recursive: true, force: true });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => mkdir(join(rootPath, `identity-consumer-${index}`)))
    );
    await mkdir(prepared.worktreePath);
    await writeFile(sentinelPath, "replacement", "utf8");
    const runner: WorktreeGitRunner & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn(async (_cwd, args) => args[1] === "list"
        ? { kind: "completed" as const, exitCode: 0, output: `worktree ${prepared.worktreePath}\n` }
        : { kind: "completed" as const, exitCode: 0, output: "" })
    };

    await expect(cleanupIsolatedWorktree("completed-replaced", {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    expect(runner.run).not.toHaveBeenCalled();
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("replacement");
    await expect(readFile(join(rootPath, "completed-replaced.json"), "utf8")).resolves.toContain('"creationComplete":true');
  });

  it("fails closed when partial metadata or the partial destination is replaced", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const investigationId = "tampered-partial";
    const destinationPath = join(rootPath, investigationId);
    const sentinelPath = join(destinationPath, "sentinel.txt");
    const runner: WorktreeGitRunner = {
      run: async (_cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: canonicalSourcePath };
        }
        if (args[0] === "worktree" && args[1] === "add") {
          await writeFile(sentinelPath, "reserved", "utf8");
          return { kind: "completed", exitCode: 1, output: "" };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { kind: "completed", exitCode: 0, output: "" };
        }
        return { kind: "failed" };
      }
    };
    await prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
      testRootPath: rootPath,
      gitRunner: runner
    });
    const originalMetadata = await readFile(join(rootPath, `${investigationId}.json`), "utf8");

    await writeFile(join(rootPath, `${investigationId}.json`), "{}", "utf8");
    await expect(cleanupIsolatedWorktree(investigationId, {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("reserved");

    await writeFile(join(rootPath, `${investigationId}.json`), originalMetadata, "utf8");
    await rm(destinationPath, { recursive: true, force: true });
    await mkdir(destinationPath);
    await writeFile(sentinelPath, "replacement", "utf8");
    await expect(cleanupIsolatedWorktree(investigationId, {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("replacement");
  });

  it("fails safely when the empty destination is replaced before identity capture", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const investigationId = "replacement-before-capture";
    const destinationPath = join(rootPath, investigationId);
    const runner: WorktreeGitRunner = {
      run: async (_cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: canonicalSourcePath };
        }
        if (args[0] === "worktree" && args[1] === "add") {
          return { kind: "completed", exitCode: 1, output: "" };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { kind: "completed", exitCode: 0, output: "" };
        }
        return { kind: "failed" };
      }
    };

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: {
        afterDestinationMkdir: async () => {
          await rm(destinationPath, { recursive: true, force: true });
          await mkdir(destinationPath);
        }
      }
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    await expect(cleanupIsolatedWorktree(investigationId, {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    await expect(readdir(destinationPath)).resolves.toEqual([]);
    await expect(readFile(join(rootPath, `${investigationId}.json`), "utf8")).resolves.toContain('"creationComplete":false');
  });

  it("preserves a non-empty replacement before identity capture", async () => {
    const sourceRepositoryPath = await createRepository();
    const rootPath = await createDirectory();
    const canonicalSourcePath = await realpath(sourceRepositoryPath);
    const investigationId = "nonempty-replacement-before-capture";
    const destinationPath = join(rootPath, investigationId);
    const sentinelPath = join(destinationPath, "sentinel.txt");
    const runner: WorktreeGitRunner = {
      run: async (_cwd, args) => {
        if (args[0] === "rev-parse") {
          return { kind: "completed", exitCode: 0, output: canonicalSourcePath };
        }
        if (args[0] === "worktree" && args[1] === "add") {
          return { kind: "completed", exitCode: 1, output: "" };
        }
        if (args[0] === "worktree" && args[1] === "list") {
          return { kind: "completed", exitCode: 0, output: "" };
        }
        return { kind: "failed" };
      }
    };

    await expect(prepareIsolatedWorktreeAttempt(sourceRepositoryPath, investigationId, {
      testRootPath: rootPath,
      gitRunner: runner,
      testHooks: {
        afterDestinationMkdir: async () => {
          await rm(destinationPath, { recursive: true, force: true });
          await mkdir(destinationPath);
          await writeFile(sentinelPath, "foreign", "utf8");
        }
      }
    })).resolves.toEqual({
      status: "failed", failure: "creation_failed", cleanupAuthorized: true
    });
    await expect(cleanupIsolatedWorktree(investigationId, {
      testRootPath: rootPath,
      gitRunner: runner
    })).resolves.toEqual({ status: "failed", failure: { code: "cleanup_failed" } });
    await expect(readFile(sentinelPath, "utf8")).resolves.toBe("foreign");
    await expect(readFile(join(rootPath, `${investigationId}.json`), "utf8")).resolves.toContain('"creationComplete":false');
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
