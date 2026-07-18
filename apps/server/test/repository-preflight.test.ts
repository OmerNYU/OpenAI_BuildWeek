import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendDependencyInstallLog,
  approvedScriptNames,
  buildInstallCommand,
  buildStartCommand,
  buildTestCommand,
  createCommandPolicy,
  initializeDependencyInstallLog,
  planDependencyInstall,
  preflightRepository,
  recordDependencyInstall,
  type GitRunner
} from "../src/repository/index.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("repository preflight", () => {
  it("accepts clean committed Next and Vite repositories with framework-specific policies", async () => {
    const nextRepository = await createRepository();
    await expect(preflightRepository(nextRepository)).resolves.toMatchObject({
      status: "ready",
      repositoryPath: await realpath(nextRepository)
    });
    const nextPolicy = await readyPolicy(nextRepository);
    expect(nextPolicy.framework).toBe("next");
    expect(buildStartCommand(nextPolicy, 3101)).toEqual({
      command: "npm",
      args: ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3101"]
    });

    const viteRepository = await createRepository({ framework: "vite" });
    const vitePolicy = await readyPolicy(viteRepository);
    expect(vitePolicy.framework).toBe("vite");
    expect(buildStartCommand(vitePolicy, 3102)).toEqual({
      command: "npm",
      args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "3102"]
    });
  });

  it("rejects unsafe, non-Git, dirty, unsupported-package-manager, and unsupported-framework repositories", async () => {
    await expect(preflightRepository(join(tmpdir(), "failspec-missing-repository"))).resolves.toMatchObject({
      status: "failed",
      failure: { code: "unsafe_path" }
    });

    const nonGit = await createDirectory();
    await expect(preflightRepository(nonGit)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "not_git_repository" }
    });

    const dirty = await createRepository();
    await writeFile(join(dirty, "untracked.txt"), "dirty", "utf8");
    await expect(preflightRepository(dirty)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "dirty_repository" }
    });

    const pnpm = await createRepository({ packageManager: "pnpm@9.0.0" });
    await expect(preflightRepository(pnpm)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "unsupported_package_manager" }
    });

    const yarn = await createRepository();
    await writeFile(join(yarn, "yarn.lock"), "", "utf8");
    await commit(yarn, "add yarn lockfile");
    await expect(preflightRepository(yarn)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "unsupported_package_manager" }
    });

    const reactWithoutVite = await createRepository({ framework: "react" });
    await expect(preflightRepository(reactWithoutVite)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "unsupported_framework" }
    });
  });

  it("rejects missing Playwright and non-string or blank approved scripts", async () => {
    const noPlaywright = await createRepository({ includePlaywright: false });
    await expect(preflightRepository(noPlaywright)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "playwright_not_configured" }
    });

    for (const scripts of [
      { dev: true, "test:generated": "playwright test" },
      { dev: " ", "test:generated": "playwright test" },
      { dev: "next dev", "test:generated": "" }
    ]) {
      const repository = await createRepository({ scripts });
      await expect(preflightRepository(repository)).resolves.toMatchObject({
        status: "unsupported",
        failure: { code: "unsupported_script" }
      });
    }
  });

  it("bounds Git inspection and classifies timeout, capped output, and first status output", async () => {
    const repository = await createRepository();
    const canonicalPath = await realpath(repository);

    const timeoutRunner: GitRunner = { run: async () => ({ kind: "timeout" }) };
    await expect(preflightRepository(repository, { gitRunner: timeoutRunner })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "inspection_failed" }
    });

    const boundedCalls: Array<{ args: readonly string[]; maxOutputBytes: number; stopOnOutput: boolean }> = [];
    const cappedOutputRunner: GitRunner = {
      run: async (_cwd, args, options) => {
        boundedCalls.push({
          args,
          maxOutputBytes: options.maxOutputBytes,
          stopOnOutput: options.stopOnOutput
        });
        return { kind: "output_limit" };
      }
    };
    await expect(preflightRepository(repository, { gitRunner: cappedOutputRunner })).resolves.toMatchObject({
      status: "failed",
      failure: { code: "inspection_failed" }
    });
    expect(boundedCalls).toEqual([
      { args: ["rev-parse", "--show-toplevel"], maxOutputBytes: 4096, stopOnOutput: false }
    ]);

    const statusCalls: Array<{ args: readonly string[]; maxOutputBytes: number; stopOnOutput: boolean }> = [];
    const dirtyStatusRunner: GitRunner = {
      run: async (_cwd, args, options) => {
        statusCalls.push({
          args,
          maxOutputBytes: options.maxOutputBytes,
          stopOnOutput: options.stopOnOutput
        });
        return args[0] === "rev-parse"
          ? { kind: "completed", exitCode: 0, output: `${canonicalPath}\n` }
          : { kind: "output" };
      }
    };
    await expect(preflightRepository(repository, { gitRunner: dirtyStatusRunner })).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "dirty_repository" }
    });
    expect(statusCalls.at(-1)).toEqual({
      args: ["status", "--porcelain", "--untracked-files=normal"],
      maxOutputBytes: 1,
      stopOnOutput: true
    });
  });

  it("builds only fixed npm commands from an approved policy", async () => {
    const policy = await readyPolicy(await createRepository());

    expect(approvedScriptNames).toEqual(["dev", "test:generated"]);
    expect(buildInstallCommand()).toEqual({ command: "npm", args: ["ci"] });
    expect(buildTestCommand(policy)).toEqual({ command: "npm", args: ["run", "test:generated"] });
    expect(() => buildStartCommand(policy, 0)).toThrow("Invalid port.");
    expect(() =>
      buildTestCommand({ ...policy, testScript: "arbitrary" } as unknown as typeof policy)
    ).toThrow("Invalid command policy.");
  });

  it("uses validated FailSpec state, preserves install logs, and tracks the lockfile only after recording", async () => {
    const worktreePath = await createRepository();
    await mkdir(join(worktreePath, "node_modules"));

    await expect(planDependencyInstall(worktreePath)).resolves.toMatchObject({
      kind: "install",
      command: { command: "npm", args: ["ci"] },
      logPath: join(await realpath(worktreePath), ".failspec", "npm-install.log")
    });
    const initialized = await initializeDependencyInstallLog(worktreePath);
    expect(initialized).toMatchObject({ kind: "ready" });
    await appendDependencyInstallLog(worktreePath, "first line\n");
    await appendDependencyInstallLog(worktreePath, "second line\n");
    if (initialized.kind !== "ready") {
      throw new Error("Expected a ready install log.");
    }
    await expect(readFile(initialized.logPath, "utf8")).resolves.toBe("first line\nsecond line\n");

    await expect(recordDependencyInstall(worktreePath)).resolves.toEqual({ kind: "recorded" });
    await expect(planDependencyInstall(worktreePath)).resolves.toMatchObject({ kind: "reuse" });

    await writeFile(join(worktreePath, "package-lock.json"), "changed", "utf8");
    await expect(planDependencyInstall(worktreePath)).resolves.toMatchObject({ kind: "install" });
  });

  it("does not return npm ci without a lockfile", async () => {
    const worktreePath = await createRepository({ includeLockfile: false });

    await expect(planDependencyInstall(worktreePath)).resolves.toEqual({
      kind: "unavailable",
      reason: "missing_lockfile"
    });
    await expect(recordDependencyInstall(worktreePath)).resolves.toEqual({
      kind: "unavailable",
      reason: "missing_lockfile"
    });
  });

  it("rejects a repository-controlled .failspec symlink without writing to its target", async () => {
    const worktreePath = await createRepository();
    const victimPath = await createDirectory();
    await symlink(victimPath, join(worktreePath, ".failspec"));

    await expect(planDependencyInstall(worktreePath)).resolves.toEqual({
      kind: "unavailable",
      reason: "unsafe_worktree_state"
    });
    await expect(recordDependencyInstall(worktreePath)).resolves.toEqual({
      kind: "unavailable",
      reason: "unsafe_worktree_state"
    });
    await expect(initializeDependencyInstallLog(worktreePath)).resolves.toEqual({
      kind: "unavailable",
      reason: "unsafe_worktree_state"
    });
    await expect(readdir(victimPath)).resolves.toEqual([]);
  });

  it("rejects symlinked state and log files", async () => {
    for (const fileName of ["npm-install-state.json", "npm-install.log"]) {
      const worktreePath = await createRepository();
      const victimPath = await createDirectory();
      await mkdir(join(worktreePath, ".failspec"));
      await symlink(join(victimPath, "target"), join(worktreePath, ".failspec", fileName));

      await expect(planDependencyInstall(worktreePath)).resolves.toEqual({
        kind: "unavailable",
        reason: "unsafe_worktree_state"
      });
      await expect(recordDependencyInstall(worktreePath)).resolves.toEqual({
        kind: "unavailable",
        reason: "unsafe_worktree_state"
      });
      await expect(initializeDependencyInstallLog(worktreePath)).resolves.toEqual({
        kind: "unavailable",
        reason: "unsafe_worktree_state"
      });
      await expect(readdir(victimPath)).resolves.toEqual([]);
    }
  });
});

async function readyPolicy(repositoryPath: string) {
  const result = await createCommandPolicy(repositoryPath);
  if (result.status !== "ready") {
    throw new Error("Expected a ready command policy.");
  }
  return result.policy;
}

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "failspec-preflight-"));
  directories.push(directory);
  return directory;
}

interface RepositoryOptions {
  framework?: "next" | "vite" | "react";
  packageManager?: string;
  includePlaywright?: boolean;
  includeLockfile?: boolean;
  scripts?: Record<string, unknown>;
}

async function createRepository(options: RepositoryOptions = {}): Promise<string> {
  const directory = await createDirectory();
  const framework = options.framework ?? "next";
  const dependencies = framework === "next"
    ? { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" }
    : { react: "19.0.0", "react-dom": "19.0.0" };
  const devDependencies = {
    ...(options.includePlaywright === false ? {} : { "@playwright/test": "1.0.0" }),
    ...(framework === "vite" ? { vite: "6.0.0" } : {})
  };
  const scripts = options.scripts ?? {
    dev: framework === "vite" ? "vite" : framework === "next" ? "next dev" : "react-scripts start",
    "test:generated": "playwright test tests/generated"
  };
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "test-repository",
      private: true,
      packageManager: options.packageManager,
      dependencies,
      devDependencies,
      scripts
    }),
    "utf8"
  );
  if (options.includeLockfile !== false) {
    await writeFile(join(directory, "package-lock.json"), "{}", "utf8");
  }
  await writeFile(join(directory, "playwright.config.ts"), "export default {};", "utf8");
  await run("git", ["init", directory]);
  await run("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", directory, "config", "user.name", "Test User"]);
  await commit(directory, "initial");
  return directory;
}

async function commit(directory: string, message: string): Promise<void> {
  await run("git", ["-C", directory, "add", "."]);
  await run("git", ["-C", directory, "commit", "-m", message]);
}
