import { link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaywrightRunnerAdapter,
  type CommandResult,
  type RunnerOperations
} from "../src/runner/playwright-runner.js";
import { stagedGeneratedTestPath } from "../src/runner/staging.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("controlled Playwright runner", () => {
  it("runs only the staged path with fixed runner arguments", async () => {
    const worktree = await createWorktree();
    const canonicalWorktree = await realpath(worktree);
    const operations = fakeOperations(report("passed"));
    const output = await new PlaywrightRunnerAdapter(operations).run(input(worktree));

    expect(operations.start).toHaveBeenCalledWith(
      { command: "npm", args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "43123"] },
      expect.objectContaining({
        cwd: canonicalWorktree,
        env: expect.objectContaining({
          FAILSPEC_BASE_URL: "http://127.0.0.1:43123",
          FAILSPEC_MANAGED_SERVER: "1"
        })
      })
    );
    expect(operations.run).toHaveBeenCalledWith(
      {
        command: "npm",
        args: ["run", "test:generated", "--", "--reporter=json", "--output", ".failspec/runner/artifacts"]
      },
      expect.any(Object)
    );
    expect(output).toMatchObject({
      execution: { command: "controlled_playwright_generated_test", timedOut: false },
      evidence: { testTitle: "generated checkout", testStatus: "passed" }
    });
    expect(operations.stop).toHaveBeenCalledTimes(1);
  });

  it("rejects an unstaged or unexpected test path before executing anything", async () => {
    const worktree = await createWorktree();
    const operations = fakeOperations(report("passed"));
    const output = await new PlaywrightRunnerAdapter(operations).run({
      repositoryPath: worktree,
      generatedTest: { path: "tests/other.spec.ts", content: "untrusted" }
    });

    expect(operations.createPolicy).not.toHaveBeenCalled();
    expect(operations.run).not.toHaveBeenCalled();
    expect(output).toMatchObject({
      execution: { exitCode: null },
      evidence: { testStatus: "unknown" }
    });
  });

  it("installs through the approved npm command and records only a successful install", async () => {
    const worktree = await createWorktree();
    const operations = fakeOperations(report("passed"));
    const planInstall = vi.fn(async () => ({
      kind: "install" as const,
      command: { command: "npm" as const, args: ["ci"] },
      logPath: ".failspec/npm-install.log"
    }));
    operations.planInstall = planInstall;

    await new PlaywrightRunnerAdapter(operations).run(input(worktree));

    expect(planInstall).toHaveBeenCalledWith(await realpath(worktree));
    expect(operations.run).toHaveBeenNthCalledWith(1, { command: "npm", args: ["ci"] }, expect.any(Object));
    expect(operations.appendInstallLog).toHaveBeenCalledTimes(1);
    expect(operations.recordInstall).toHaveBeenCalledTimes(1);
  });

  it("normalizes contained reporter facts and drops escaping artifacts", async () => {
    const worktree = await createWorktree();
    const operations = fakeOperations(report("failed", await realpath(worktree)));
    const output = await new PlaywrightRunnerAdapter(operations).run(input(worktree));

    expect(output.evidence).toMatchObject({
      testTitle: "generated checkout",
      testStatus: "failed",
      assertionFailureMessage: "Expected [path]",
      failureLocation: { file: "src/checkout.tsx", line: 12, column: 3 },
      artifactPaths: [".failspec/runner/artifacts/trace.zip"]
    });
    expect(output.evidence.artifactPaths).not.toContain("../../secret.zip");
    expect(JSON.stringify(output)).not.toContain(worktree);
  });

  it("records a bounded timeout as execution fact without assigning a verdict", async () => {
    const worktree = await createWorktree();
    const operations = fakeOperations("", { timedOut: true, exitCode: null });
    const output = await new PlaywrightRunnerAdapter(operations).run(input(worktree));

    expect(output).toMatchObject({
      execution: { timedOut: true, exitCode: null },
      evidence: { testStatus: "timedOut" }
    });
    expect(operations.stop).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the JSON reporter is malformed", async () => {
    const worktree = await createWorktree();
    const output = await new PlaywrightRunnerAdapter(fakeOperations("not json")).run(input(worktree));

    expect(output).toMatchObject({ evidence: { testStatus: "unknown", artifactPaths: [] } });
  });

  it("does not overwrite a pre-existing runner report inode", async () => {
    const worktree = await createWorktree();
    const victimDirectory = await mkdtemp(join(tmpdir(), "failspec-runner-victim-"));
    directories.push(victimDirectory);
    const victim = join(victimDirectory, "report.json");
    const reportPath = join(worktree, ".failspec", "runner", "playwright-report.json");
    await mkdir(join(worktree, ".failspec", "runner"), { recursive: true });
    await writeFile(victim, "unchanged", "utf8");
    await link(victim, reportPath);

    const output = await new PlaywrightRunnerAdapter(fakeOperations(report("passed"))).run(input(worktree));

    expect(output).toMatchObject({ evidence: { testStatus: "unknown" } });
    await expect(readFile(victim, "utf8")).resolves.toBe("unchanged");
  });
});

async function createWorktree(): Promise<string> {
  const worktree = await mkdtemp(join(tmpdir(), "failspec-playwright-runner-"));
  directories.push(worktree);
  await mkdir(join(worktree, "tests", "generated"), { recursive: true });
  await writeFile(join(worktree, stagedGeneratedTestPath), "staged", "utf8");
  return worktree;
}

function input(worktree: string) {
  return { repositoryPath: worktree, generatedTest: { path: stagedGeneratedTestPath, content: "ignored" } };
}

function fakeOperations(reporter: string, result: Partial<CommandResult> = {}): RunnerOperations & { stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async () => undefined);
  const complete: CommandResult = {
    exitCode: 0,
    stdout: reporter,
    stderr: "",
    timedOut: false,
    durationMs: 10,
    ...result
  };
  return {
    createPolicy: vi.fn(async (repositoryPath) => ({
      status: "ready" as const,
      policy: { repositoryPath, framework: "vite" as const, startScript: "dev" as const, testScript: "test:generated" as const }
    })),
    planInstall: vi.fn(async () => ({ kind: "reuse" as const, logPath: ".failspec/npm-install.log" })),
    appendInstallLog: vi.fn(async () => ({ kind: "appended" as const, logPath: ".failspec/npm-install.log" })),
    recordInstall: vi.fn(async () => ({ kind: "recorded" as const })),
    allocatePort: vi.fn(async () => 43123),
    waitForReady: vi.fn(async () => true),
    run: vi.fn(async () => complete),
    start: vi.fn(async () => ({ stop })),
    stop
  };
}

function report(status: string, worktree = ""): string {
  return JSON.stringify({
    suites: [{ specs: [{ title: "generated checkout", tests: [{ results: [{
      status,
      errors: status === "failed" ? [{
        message: "Expected " + join(worktree, "private", "secret"),
        location: { file: join(worktree, "src", "checkout.tsx"), line: 12, column: 3 }
      }] : [],
      attachments: [{ path: "trace.zip" }, { path: "../../secret.zip" }]
    }] }] }] }]
  });
}
