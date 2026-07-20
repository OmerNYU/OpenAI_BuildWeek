import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PlaywrightRunnerAdapter,
  waitForReady,
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
    await writeFile(join(worktree, "tests", "generated", "sentinel.spec.ts"), "must not run", "utf8");
    const operations = fakeOperations(report("passed"));
    const output = await new PlaywrightRunnerAdapter(operations).run(input(worktree));

    expect(operations.start).toHaveBeenCalledWith(
      { command: "npm", args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "43123", "--strictPort"] },
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
    expect(operations.run).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      env: expect.objectContaining({ PLAYWRIGHT_JSON_OUTPUT_FILE: join(canonicalWorktree, ".failspec", "runner", "playwright-report.json") })
    }));
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

  it("requires staged content to match the generated-test handoff", async () => {
    const worktree = await createWorktree();
    const operations = fakeOperations(report("passed"));
    const output = await new PlaywrightRunnerAdapter(operations).run({
      repositoryPath: worktree,
      generatedTest: { path: stagedGeneratedTestPath, content: "different" }
    });

    expect(operations.createPolicy).not.toHaveBeenCalled();
    expect(output.evidence.testStatus).toBe("unknown");
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

  it("uses the reporter file instead of noisy npm stdout", async () => {
    const worktree = await createWorktree();
    const output = await new PlaywrightRunnerAdapter(fakeOperations(report("passed"), {
      stdout: "> package test:generated\n> playwright test\nnot json"
    })).run(input(worktree));

    expect(output.evidence).toMatchObject({ testTitle: "generated checkout", testStatus: "passed" });
  });

  it("uses final retries and aggregates project statuses deterministically", async () => {
    const worktree = await createWorktree();
    const retryReport = projectsReport([
      { project: "chromium", results: [{ status: "failed", retry: 0 }, { status: "passed", retry: 1 }] },
      { project: "firefox", results: [{ status: "passed", retry: 0 }] }
    ]);
    await expect(new PlaywrightRunnerAdapter(fakeOperations(retryReport)).run(input(worktree))).resolves.toMatchObject({
      evidence: { testStatus: "passed" }
    });

    const failureReport = projectsReport([
      { project: "firefox", results: [{ status: "passed", retry: 0 }] },
      { project: "chromium", results: [{ status: "failed", retry: 0, errors: [{ message: "chromium failure" }] }] }
    ]);
    await expect(new PlaywrightRunnerAdapter(fakeOperations(failureReport)).run(input(await createWorktree()))).resolves.toMatchObject({
      evidence: { testStatus: "failed", assertionFailureMessage: "chromium failure" }
    });
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

  it("preserves failed execution facts when Playwright produces no reporter file", async () => {
    const worktree = await createWorktree();
    const operations = fakeOperations(report("passed"));
    operations.run = vi.fn(async () => ({
      exitCode: 1,
      stdout: "> npm run test:generated",
      stderr: "reporter failed",
      timedOut: false,
      durationMs: 321
    }));

    const output = await new PlaywrightRunnerAdapter(operations).run(input(worktree));

    expect(output).toMatchObject({
      execution: { command: "controlled_playwright_generated_test", exitCode: 1, timedOut: false, durationMs: 321 },
      evidence: { testStatus: "unknown", artifactPaths: [] }
    });
  });

  it("rejects an unrelated readiness response when the managed child exits from a port collision", async () => {
    const worktree = await createWorktree();
    const operations = fakeOperations(report("passed"));
    operations.start = vi.fn(async () => ({ isRunning: () => false, stop: operations.stop }));

    const output = await new PlaywrightRunnerAdapter(operations).run(input(worktree));

    expect(operations.run).not.toHaveBeenCalled();
    expect(operations.stop).toHaveBeenCalledTimes(1);
    expect(output.evidence.testStatus).toBe("unknown");
  });

  it("uses redirect:error for loopback readiness", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetch);
    try {
      await expect(waitForReady("http://127.0.0.1:43123")).resolves.toBe(true);
      expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43123", expect.objectContaining({ redirect: "error" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("removes absolute paths and external URLs without obscuring loopback URLs", async () => {
    const worktree = await createWorktree();
    const output = await new PlaywrightRunnerAdapter(fakeOperations(projectsReport([{
      project: "chromium",
      results: [{
        status: "failed",
        retry: 0,
        errors: [{ message: "C:\\Users\\Omer Hayat\\repo\\secret.ts:1:2\n/Users/Omer Hayat/repo/secret.ts:3:4\nhttp://127.0.0.1:43123/checkout?session=secret\nhttps://example.com/private?token=secret" }]
      }]
    }]))).run(input(worktree));

    expect(output.evidence.assertionFailureMessage).not.toContain("Omer Hayat");
    expect(output.evidence.assertionFailureMessage).not.toContain("example.com");
    expect(output.evidence.assertionFailureMessage).not.toContain("secret");
    expect(output.evidence.assertionFailureMessage).toContain("http://127.0.0.1:43123/checkout");
  });

  it("does not delete or overwrite repository-provided runner artifacts", async () => {
    const worktree = await createWorktree();
    const sentinel = join(worktree, ".failspec", "runner", "artifacts", "sentinel.txt");
    await mkdir(dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "unchanged", "utf8");

    const output = await new PlaywrightRunnerAdapter(fakeOperations(report("passed"))).run(input(worktree));

    expect(output).toMatchObject({ evidence: { testStatus: "unknown" } });
    expect(output.execution.exitCode).toBeNull();
    await expect(readFile(sentinel, "utf8")).resolves.toBe("unchanged");
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
  return { repositoryPath: worktree, generatedTest: { path: stagedGeneratedTestPath, content: "staged" } };
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
    run: vi.fn(async (command, options) => {
      if (command.args.includes("test:generated")) {
        const reportPath = options.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
        if (reportPath) {
          await mkdir(join(dirname(reportPath), "artifacts"), { recursive: true });
          await writeFile(join(dirname(reportPath), "artifacts", "trace.zip"), "trace", "utf8");
          await writeFile(reportPath, reporter, "utf8");
        }
      }
      return complete;
    }),
    start: vi.fn(async () => ({ isRunning: () => true, stop })),
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

function projectsReport(projects: Array<{ project: string; results: Array<Record<string, unknown>> }>): string {
  return JSON.stringify({
    suites: projects.map(({ project, results }) => ({
      projectName: project,
      specs: [{ title: "generated checkout", tests: [{ results }] }]
    }))
  });
}
