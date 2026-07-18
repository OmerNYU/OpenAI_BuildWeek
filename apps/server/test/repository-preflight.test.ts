import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedScriptNames,
  buildInstallCommand,
  buildStartCommand,
  buildTestCommand,
  createCommandPolicy,
  planDependencyInstall,
  preflightRepository,
  recordDependencyInstall
} from "../src/repository/index.js";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("repository preflight", () => {
  it("accepts a clean committed Next repository", async () => {
    const repositoryPath = await createRepository();

    await expect(preflightRepository(repositoryPath)).resolves.toMatchObject({
      status: "ready",
      repositoryPath: await realpath(repositoryPath)
    });

    const reactRepository = await createRepository({
      dependencies: { react: "19.0.0", "react-dom": "19.0.0" }
    });
    await expect(preflightRepository(reactRepository)).resolves.toMatchObject({ status: "ready" });
  });

  it("rejects missing, non-Git, dirty, and unsupported repositories", async () => {
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
    await run("git", ["-C", yarn, "add", "yarn.lock"]);
    await run("git", ["-C", yarn, "commit", "-m", "add yarn lockfile"]);
    await expect(preflightRepository(yarn)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "unsupported_package_manager" }
    });
  });

  it("rejects repositories without Playwright or approved scripts", async () => {
    const unsupportedFramework = await createRepository({ dependencies: {} });
    await expect(preflightRepository(unsupportedFramework)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "unsupported_framework" }
    });

    const noPlaywright = await createRepository({ devDependencies: {} });
    await expect(preflightRepository(noPlaywright)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "playwright_not_configured" }
    });

    const noGeneratedScript = await createRepository({ scripts: { dev: "next dev" } });
    await expect(preflightRepository(noGeneratedScript)).resolves.toMatchObject({
      status: "unsupported",
      failure: { code: "unsupported_script" }
    });
  });

  it("builds only fixed npm commands from an approved policy", async () => {
    const repositoryPath = await createRepository();
    const result = await createCommandPolicy(repositoryPath);
    if (result.status !== "ready") {
      throw new Error("Expected a ready command policy.");
    }

    expect(approvedScriptNames).toEqual(["dev", "test:generated"]);
    expect(buildInstallCommand()).toEqual({ command: "npm", args: ["ci"] });
    expect(buildStartCommand(result.policy, 3101)).toEqual({
      command: "npm",
      args: ["run", "dev", "--", "--hostname", "127.0.0.1", "--port", "3101"]
    });
    expect(buildTestCommand(result.policy)).toEqual({ command: "npm", args: ["run", "test:generated"] });
    expect(() => buildStartCommand(result.policy, 0)).toThrow("Invalid port.");
    expect(() =>
      buildTestCommand({ ...result.policy, testScript: "arbitrary" } as unknown as typeof result.policy)
    ).toThrow("Invalid command policy.");
  });

  it("uses only FailSpec-owned install state and ignores node_modules", async () => {
    const worktreePath = await createRepository();
    await mkdir(join(worktreePath, "node_modules"));

    await expect(planDependencyInstall(worktreePath)).resolves.toMatchObject({
      kind: "install",
      command: { command: "npm", args: ["ci"] },
      logPath: join(worktreePath, ".failspec", "npm-install.log")
    });

    await recordDependencyInstall(worktreePath);
    await expect(planDependencyInstall(worktreePath)).resolves.toMatchObject({
      kind: "reuse",
      logPath: join(worktreePath, ".failspec", "npm-install.log")
    });

    await writeFile(join(worktreePath, "package-lock.json"), "changed", "utf8");
    await expect(planDependencyInstall(worktreePath)).resolves.toMatchObject({ kind: "install" });
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "failspec-preflight-"));
  directories.push(directory);
  return directory;
}

async function createRepository(overrides: Partial<Record<string, unknown>> = {}): Promise<string> {
  const directory = await createDirectory();
  const packageJson = {
    name: "test-repository",
    private: true,
    dependencies: { next: "15.0.0", react: "19.0.0", "react-dom": "19.0.0" },
    devDependencies: { "@playwright/test": "1.0.0" },
    scripts: { dev: "next dev", "test:generated": "playwright test tests/generated" },
    ...overrides
  };
  await writeFile(join(directory, "package.json"), JSON.stringify(packageJson), "utf8");
  await writeFile(join(directory, "package-lock.json"), "{}", "utf8");
  await writeFile(join(directory, "playwright.config.ts"), "export default {};", "utf8");
  await run("git", ["init", directory]);
  await run("git", ["-C", directory, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", directory, "config", "user.name", "Test User"]);
  await run("git", ["-C", directory, "add", "."]);
  await run("git", ["-C", directory, "commit", "-m", "initial"]);
  return directory;
}
