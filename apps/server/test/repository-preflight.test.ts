import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendDependencyInstallLog,
  approvedScriptNames,
  approvedGeneratedTestScript,
  buildInstallCommand,
  buildStartCommand,
  buildTestCommand,
  createCommandPolicy,
  createRunnerCommandPolicy,
  initializeDependencyInstallLog,
  planDependencyInstall,
  preflightRepository,
  recordDependencyInstall,
  supportedFrameworkPolicies,
  type GitRunner
} from "../src/repository/index.js";

const run = promisify(execFile);
const directories: string[] = [];
const fixturePlaywrightConfigPath = fileURLToPath(
  new URL("../../../fixtures/buggy-checkout-app/playwright.config.ts", import.meta.url)
);

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

  it("accepts the committed fixture root Playwright configuration", async () => {
    const repository = await createRepository({
      playwrightConfigContent: await readFile(fixturePlaywrightConfigPath, "utf8")
    });

    await expect(preflightRepository(repository)).resolves.toMatchObject({ status: "ready" });
  });

  it("revalidates the approved command policy after the fixed generated test makes a worktree dirty", async () => {
    const repository = await createRepository({ framework: "vite" });
    await mkdir(join(repository, "tests", "generated"), { recursive: true });
    await writeFile(join(repository, "tests", "generated", "failspec.generated.spec.ts"), "staged", "utf8");

    await expect(createCommandPolicy(repository)).resolves.toMatchObject({
      status: "unsupported", failure: { code: "dirty_repository" }
    });
    await expect(createRunnerCommandPolicy(repository)).resolves.toMatchObject({
      status: "ready", policy: { framework: "vite", testScript: "test:generated" }
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

  it("rejects missing or runner-incompatible Playwright and non-string or blank approved scripts", async () => {
    const noPlaywright = await createRepository({ includePlaywright: false });
    await expect(preflightRepository(noPlaywright)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "playwright_not_configured" }
    });
    const incompatiblePlaywright = await createRepository({ playwrightConfigContent: "export default {};" });
    await expect(preflightRepository(incompatiblePlaywright)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "playwright_not_configured" }
    });
    for (const playwrightConfigContent of [
      "const baseURL = process.env.FAILSPEC_BASE_URL; export default { baseURL };",
      "const managed = process.env.FAILSPEC_MANAGED_SERVER; export default { managed };"
    ]) {
      const repository = await createRepository({ playwrightConfigContent });
      await expect(preflightRepository(repository)).resolves.toMatchObject({
        status: "unsupported",
        failure: { code: "playwright_not_configured" }
      });
    }

    for (const scripts of [
      { dev: true, "test:generated": approvedGeneratedTestScript },
      { dev: " ", "test:generated": approvedGeneratedTestScript },
      { dev: "next dev", "test:generated": "" },
      { dev: "next dev", "test:generated": "echo generated test" }
    ]) {
      const repository = await createRepository({ scripts });
      await expect(preflightRepository(repository)).resolves.toMatchObject({
        status: "unsupported",
        failure: { code: "unsupported_script" }
      });
    }
  });

  it("rejects scripts that merely mention a supported framework", async () => {
    for (const [framework, scripts] of [
      ["next", { dev: "echo next", "test:generated": approvedGeneratedTestScript }],
      ["next", { dev: "next dev --turbo", "test:generated": approvedGeneratedTestScript }],
      ["vite", { dev: "echo vite", "test:generated": approvedGeneratedTestScript }],
      ["vite", { dev: "npm exec vite", "test:generated": approvedGeneratedTestScript }]
    ] as const) {
      const repository = await createRepository({ framework, scripts });
      await expect(preflightRepository(repository)).resolves.toMatchObject({
        status: "unsupported",
        failure: { code: "unsupported_framework" }
      });
    }
    expect(supportedFrameworkPolicies).toEqual({
      next: { requiredDependencies: ["next", "react", "react-dom"], devScript: "next dev" },
      vite: { requiredDependencies: ["react", "react-dom", "vite"], devScript: "vite" }
    });
    expect(approvedGeneratedTestScript).toBe("playwright test tests/generated/failspec.generated.spec.ts");
  });

  it("bounds Git inspection, canonicalizes Git roots, and classifies first status output", async () => {
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

    const reportedPath = process.platform === "win32"
      ? canonicalPath.replaceAll("\\", "/")
      : canonicalPath.replaceAll("/", "\\");
    const canonicalPathRunner: GitRunner = {
      run: async (_cwd, args) => args[0] === "rev-parse"
        ? { kind: "completed", exitCode: 0, output: `${reportedPath}\r\n` }
        : { kind: "completed", exitCode: 0, output: "" }
    };
    await expect(preflightRepository(repository, { gitRunner: canonicalPathRunner })).resolves.toMatchObject({
      status: "ready",
      repositoryPath: canonicalPath
    });

    const otherRepository = await createRepository();
    const otherCanonicalPath = await realpath(otherRepository);
    const differentPathRunner: GitRunner = {
      run: async (_cwd, args) => args[0] === "rev-parse"
        ? { kind: "completed", exitCode: 0, output: `${otherCanonicalPath}\r\n` }
        : { kind: "completed", exitCode: 0, output: "" }
    };
    await expect(preflightRepository(repository, { gitRunner: differentPathRunner })).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "not_git_repository" }
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

    await rm(join(worktreePath, "node_modules"), { recursive: true });
    await expect(planDependencyInstall(worktreePath)).resolves.toMatchObject({
      kind: "install",
      command: { command: "npm", args: ["ci"] }
    });

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

  it("does not reuse a lockfile hash committed by the repository", async () => {
    const worktreePath = await createRepository();
    const lockfile = await readFile(join(worktreePath, "package-lock.json"), "utf8");
    await mkdir(join(worktreePath, ".failspec"));
    await writeFile(
      join(worktreePath, ".failspec", "npm-install-state.json"),
      createHash("sha256").update(lockfile).digest("hex"),
      "utf8"
    );
    await commit(worktreePath, "commit fake install state");

    await expect(planDependencyInstall(worktreePath)).resolves.toMatchObject({
      kind: "install",
      command: { command: "npm", args: ["ci"] }
    });
    await expect(recordDependencyInstall(worktreePath)).resolves.toEqual({
      kind: "unavailable",
      reason: "unsafe_worktree_state"
    });
  });

  it("does not append to an install log committed by the repository", async () => {
    const worktreePath = await createRepository();
    const logPath = join(worktreePath, ".failspec", "npm-install.log");
    await mkdir(join(worktreePath, ".failspec"));
    await writeFile(logPath, "repository log\n", "utf8");
    await commit(worktreePath, "commit fake install log");

    await expect(initializeDependencyInstallLog(worktreePath)).resolves.toEqual({
      kind: "unavailable",
      reason: "unsafe_worktree_state"
    });
    await expect(appendDependencyInstallLog(worktreePath, "runner output\n")).resolves.toEqual({
      kind: "unavailable",
      reason: "unsafe_worktree_state"
    });
    await expect(readFile(logPath, "utf8")).resolves.toBe("repository log\n");
  });

  it("rejects a repository-controlled .failspec symlink without writing to its target", async () => {
    const worktreePath = await createRepository();
    const victimPath = await createDirectory();
    await createDirectoryLink(victimPath, join(worktreePath, ".failspec"));

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

  it("rejects symlinked state and log files on POSIX", async () => {
    if (process.platform === "win32") {
      return;
    }
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

async function createDirectoryLink(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
}

interface RepositoryOptions {
  framework?: "next" | "vite" | "react";
  packageManager?: string;
  includePlaywright?: boolean;
  includeLockfile?: boolean;
  scripts?: Record<string, unknown>;
  playwrightConfigContent?: string;
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
    "test:generated": approvedGeneratedTestScript
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
  await writeFile(
    join(directory, "playwright.config.ts"),
    options.playwrightConfigContent ?? "const baseURL = process.env.FAILSPEC_BASE_URL;\nconst managed = process.env.FAILSPEC_MANAGED_SERVER;\nexport default { baseURL, managed };",
    "utf8"
  );
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
