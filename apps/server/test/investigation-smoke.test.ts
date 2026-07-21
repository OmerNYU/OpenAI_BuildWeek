import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  investigationSchema,
  type CodexAnalysisResult,
  type Investigation,
  type InvestigationRequest,
  type RunnerOutput
} from "@failspec/contracts";
import {
  classifyVerification,
  type CodexAdapter,
  type GenerateTestInput,
  type GeneratedTest,
  type RunnerAdapter,
  type RunnerInput,
  type VerificationInput
} from "@failspec/core";
import { createApp } from "../src/app.js";
import { PassThroughRepositoryWorkspace, LocalRepositoryWorkspace } from "../src/repository/repository-workspace.js";
import { cleanupIsolatedWorktree, preflightRepository, prepareIsolatedWorktree } from "../src/repository/index.js";
import { stageGeneratedTest } from "../src/runner/staging.js";
import { createRuntimeDependencies } from "../src/runtime-dependencies.js";
import type { WorkflowScheduler } from "../src/scheduling/workflow-scheduler.js";
import { JsonInvestigationStore } from "../src/storage/json-investigation-store.js";
import type { InvestigationStore } from "../src/storage/investigation-store.js";

const run = promisify(execFile);
const fixtureDirectory = fileURLToPath(new URL("../../../fixtures/buggy-checkout-app/", import.meta.url));
const temporaryRoots: string[] = [];

const checkoutRequest = {
  bugTitle: "Checkout ignores quantity",
  bugDescription: "Setting checkout quantity to 2 charges $12.00 instead of $24.00.",
  expectedBehavior: "The charged total is $24.00 because two notebooks cost $12.00 each.",
  actualBehavior: "The checkout confirms Charged total: $12.00."
} satisfies Omit<InvestigationRequest, "repositoryPath">;

const generatedCheckoutTest = `import { expect, test } from '@playwright/test';

test('reports the correct total for two notebooks', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Quantity').fill('2');
  await page.getByText('Complete checkout').click();
  await expect(page.getByRole('status')).toHaveText('Charged total: $24.00');
});
`;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("investigation smoke flow", () => {
  it("runs the deterministic mock API flow through persistence and reload", async () => {
    const root = await createTemporaryRoot();
    const investigationDirectory = join(root, "investigations");
    const sourceRepositoryPath = await copyCommittedFixture(root);
    const sourceHead = await git(sourceRepositoryPath, ["rev-parse", "HEAD"]);
    const scheduler = new ManualWorkflowScheduler();
    const dependencies = createRuntimeDependencies({
      env: { FAILSPEC_CODEX_MODE: "mock" },
      investigationDirectory
    });
    const app = createApp({ ...dependencies, scheduler });
    const requestBody = { repositoryPath: sourceRepositoryPath, ...checkoutRequest };

    expect(dependencies.repositoryWorkspace).toBeInstanceOf(PassThroughRepositoryWorkspace);
    const created = await request(app).post("/api/investigations").send(requestBody);

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("created");
    expect(created.body.timeline.map((event: { status: string }) => event.status)).toEqual(["created"]);
    expect(scheduler.pendingTaskCount).toBe(1);
    await expect(request(app).get(`/api/investigations/${created.body.id}`)).resolves.toMatchObject({
      status: 200,
      body: created.body
    });

    await scheduler.runNext();
    const completed = await getTerminalInvestigation(app, created.body.id);
    const reloaded = await new JsonInvestigationStore(investigationDirectory).getById(created.body.id);

    expect(completed.status).toBe("verified");
    expect(completed.verification).toMatchObject({
      verdict: "verified",
      supportingSignals: [{ type: "mock_verification", message: "Deterministic mock verification completed." }]
    });
    expect(completed.verdictExplanation).toBe(completed.verification.explanation);
    expect(completed.recommendedNextStep).toBe(completed.verification.recommendedNextStep);
    expect(completed.timeline.map((event) => event.status)).toEqual([
      "created", "preflight", "analyzing", "hypothesis_ready", "generating_test", "test_ready", "executing", "verified"
    ]);
    expect(reloaded).toEqual(completed);
    expect(investigationSchema.parse(reloaded)).toEqual(completed);
    await assertSourceRepositoryUnchanged(sourceRepositoryPath, sourceHead);
  });

  it("runs a local-style fixture investigation through staging, cleanup, classification, and reload", async () => {
    const scenario = await createLocalScenario(localPartialOutput());
    const created = await startScenario(scenario);

    await scenario.scheduler.runNext();
    const completed = await getTerminalInvestigation(scenario.app, created.id);
    await assertLocalScenarioSafety(scenario, created.id, completed);

    expect(scenario.events[0]).toBe("staging:staged");
    expect(completed.timeline.map((event) => event.status)).toEqual([
      "created", "preflight", "analyzing", "hypothesis_ready", "generating_test", "test_ready", "executing", "partial"
    ]);
    expect(completed.status).toBe("partial");
    expect(completed.verification?.verdict).toBe("partial");
    expect(completed.verification?.supportingSignals.map((signal) => signal.type)).toEqual([
      "exit_code", "test_status", "test_title", "assertion_failure", "failure_location", "console_error", "artifact_path"
    ]);
    expect(completed.verdictExplanation).toBe(completed.verification?.explanation);
    expect(completed.recommendedNextStep).toBe(completed.verification?.recommendedNextStep);
    expect(scenario.codex.repositoryPaths).toEqual([scenario.worktreePath, scenario.worktreePath]);
    expect(scenario.runner.repositoryPaths).toEqual([scenario.worktreePath]);
    expect(scenario.runner.generatedTestPaths).toEqual(["tests/generated/failspec.generated.spec.ts"]);
    expect(scenario.events).toEqual([
      "staging:staged",
      "execution-persisted",
      "cleanup:cleaned",
      "classifier",
      "verification-persisted"
    ]);
    expect(scenario.classify).toHaveBeenCalledTimes(1);
    expect(scenario.cleanupCalls).toBe(1);
    expect(scenario.worktreePath).not.toBe(scenario.sourceRepositoryPath);
    await expect(stat(scenario.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("persists a classifier-produced execution error without treating it as an operational failure", async () => {
    const scenario = await createLocalScenario(localExecutionErrorOutput());
    const created = await startScenario(scenario);

    await scenario.scheduler.runNext();
    const completed = await getTerminalInvestigation(scenario.app, created.id);
    await assertLocalScenarioSafety(scenario, created.id, completed);

    expect(completed.status).toBe("execution_error");
    expect(completed.verification).toMatchObject({ verdict: "execution_error" });
    expect(completed.execution).toEqual(localExecutionErrorOutput().execution);
    expect(completed.executionEvidence).toEqual(localExecutionErrorOutput().evidence);
    expect(completed.verdictExplanation).toBe(completed.verification?.explanation);
    expect(completed.recommendedNextStep).toBe(completed.verification?.recommendedNextStep);
    expect(completed.timeline.at(-1)?.message).toBe("Execution evidence could not be classified as a valid reproduction.");
    expect(scenario.classify).toHaveBeenCalledTimes(1);
    expect(scenario.cleanupCalls).toBe(1);
    await expect(stat(scenario.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("records a safe operational workflow error and cleans the prepared workspace", async () => {
    const scenario = await createLocalScenario(undefined, new ThrowingRunnerAdapter());
    const created = await startScenario(scenario);

    await scenario.scheduler.runNext();
    const completed = await getTerminalInvestigation(scenario.app, created.id);
    await assertLocalScenarioSafety(scenario, created.id, completed, [
      "C:\\smoke-secret-worktree",
      "SMOKE_INTERNAL_RUNNER_FAILURE"
    ]);

    expect(completed.status).toBe("execution_error");
    expect(completed.verification).toBeUndefined();
    expect(completed.hypothesis).toBeDefined();
    expect(completed.generatedTestPath).toBe("tests/generated/failspec.generated.spec.ts");
    expect(completed.verdictExplanation).toBe("Investigation workflow failed. Review the recorded investigation evidence.");
    expect(completed.recommendedNextStep).toBe("Resolve the reported workflow error and retry the investigation.");
    expect(scenario.classify).not.toHaveBeenCalled();
    expect(scenario.cleanupCalls).toBe(1);
    expect(scenario.events).toContain("cleanup:cleaned");
    await expect(stat(scenario.worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createLocalScenario(
  output: RunnerOutput | undefined,
  runnerAdapter: RunnerAdapter = new RecordingRunnerAdapter(output ?? localPartialOutput())
) {
  const root = await createTemporaryRoot();
  const sourceRepositoryPath = await copyCommittedFixture(root);
  const worktreeRoot = join(root, "owned-worktrees");
  const investigationDirectory = join(root, "investigations");
  await mkdir(worktreeRoot);
  const sourceHead = await git(sourceRepositoryPath, ["rev-parse", "HEAD"]);
  const events: string[] = [];
  let worktreePath = "";
  let cleanupCalls = 0;
  const workspace = new LocalRepositoryWorkspace({
    preflightRepository,
    prepareIsolatedWorktree: async (path, investigationId) => {
      const result = await prepareIsolatedWorktree(path, investigationId, { testRootPath: worktreeRoot });
      if (result.status === "prepared") {
        worktreePath = result.worktreePath;
      }
      return result;
    },
    cleanupIsolatedWorktree: async (investigationId) => {
      cleanupCalls += 1;
      const result = await cleanupIsolatedWorktree(investigationId, { testRootPath: worktreeRoot });
      if (result.status === "cleaned") {
        events.push("cleanup:cleaned");
      }
      return result;
    }
  });
  const store = new RecordingInvestigationStore(new JsonInvestigationStore(investigationDirectory), events);
  const scheduler = new ManualWorkflowScheduler();
  const codex = new RecordingCodexAdapter();
  const recordingRunner = runnerAdapter instanceof RecordingRunnerAdapter ? runnerAdapter : undefined;
  const classify = vi.fn((input: VerificationInput) => {
    events.push("classifier");
    return classifyVerification(input);
  });
  const app = createApp({
    mode: "local",
    store,
    scheduler,
    codexAdapter: codex,
    runnerAdapter,
    repositoryWorkspace: workspace,
    generatedTestStager: async (path, content) => {
      const result = await stageGeneratedTest(path, content);
      events.push(`staging:${result.status}${result.status === "staged" ? "" : `:${result.failure.code}`}`);
      return result;
    },
    verificationClassifier: classify
  });

  return {
    app,
    classify,
    codex,
    events,
    investigationDirectory,
    runner: recordingRunner ?? { repositoryPaths: [], generatedTestPaths: [] },
    scheduler,
    sourceHead,
    sourceRepositoryPath,
    get cleanupCalls() { return cleanupCalls; },
    get worktreePath() { return worktreePath; }
  };
}

async function startScenario(scenario: Awaited<ReturnType<typeof createLocalScenario>>) {
  const created = await request(scenario.app).post("/api/investigations").send({
    repositoryPath: scenario.sourceRepositoryPath,
    ...checkoutRequest
  });

  expect(created.status).toBe(201);
  expect(created.body.status).toBe("created");
  expect(created.body.timeline.map((event: { status: string }) => event.status)).toEqual(["created"]);
  expect(scenario.scheduler.pendingTaskCount).toBe(1);
  const beforeWorkflow = await request(scenario.app).get(`/api/investigations/${created.body.id}`);
  expect(beforeWorkflow.body).toEqual(created.body);
  return investigationSchema.parse(created.body);
}

async function assertLocalScenarioSafety(
  scenario: Awaited<ReturnType<typeof createLocalScenario>>,
  investigationId: string,
  completed: Investigation,
  sensitiveValues: readonly string[] = []
) {
  const persisted = await new JsonInvestigationStore(scenario.investigationDirectory).getById(investigationId);
  const response = await request(scenario.app).get(`/api/investigations/${investigationId}`);
  const reloaded = investigationSchema.parse(response.body);
  const forbiddenValues = [scenario.worktreePath, ...sensitiveValues];

  expect(investigationSchema.parse(persisted)).toEqual(completed);
  expect(reloaded).toEqual(completed);
  expect(completed.request.repositoryPath).toBe(scenario.sourceRepositoryPath);
  for (const record of [completed, persisted, reloaded]) {
    expectStringValuesToExclude(record, forbiddenValues);
  }
  await assertSourceRepositoryUnchanged(scenario.sourceRepositoryPath, scenario.sourceHead);
}

async function getTerminalInvestigation(app: ReturnType<typeof createApp>, investigationId: string): Promise<Investigation> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await request(app).get(`/api/investigations/${investigationId}`);
    const investigation = investigationSchema.parse(response.body);
    if (["verified", "partial", "not_reproduced", "execution_error"].includes(investigation.status)) {
      return investigation;
    }
  }
  throw new Error("Smoke investigation did not reach a terminal status within three GET attempts.");
}

async function copyCommittedFixture(root: string): Promise<string> {
  const destination = join(root, "source-repository");
  await cp(fixtureDirectory, destination, {
    recursive: true,
    filter: (path) => ![".git", "node_modules", ".failspec", "playwright-report", "test-results", "traces"].includes(path.split(/[\\/]/).at(-1) ?? "")
  });
  await git(destination, ["init"]);
  await git(destination, ["config", "user.email", "failspec-smoke@example.test"]);
  await git(destination, ["config", "user.name", "FailSpec Smoke"]);
  await git(destination, ["add", "."]);
  await git(destination, ["commit", "-m", "fixture baseline"]);
  expect(await git(destination, ["status", "--porcelain"])).toBe("");
  return destination;
}

async function assertSourceRepositoryUnchanged(sourceRepositoryPath: string, expectedHead: string): Promise<void> {
  expect(await git(sourceRepositoryPath, ["rev-parse", "HEAD"])).toBe(expectedHead);
  expect(await git(sourceRepositoryPath, ["status", "--porcelain"])).toBe("");
  await expect(readFile(join(sourceRepositoryPath, "tests", "generated", "failspec.generated.spec.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
}

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "failspec-investigation-smoke-"));
  temporaryRoots.push(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}

class ManualWorkflowScheduler implements WorkflowScheduler {
  private readonly tasks: Array<() => Promise<void>> = [];

  get pendingTaskCount(): number {
    return this.tasks.length;
  }

  schedule(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  async runNext(): Promise<void> {
    const task = this.tasks.shift();
    if (!task) {
      throw new Error("No scheduled smoke workflow task is pending.");
    }
    await task();
  }
}

class RecordingInvestigationStore implements InvestigationStore {
  constructor(private readonly store: InvestigationStore, private readonly events: string[]) {}

  async save(investigation: Investigation): Promise<void> {
    await this.store.save(investigation);
    if (investigation.execution && !investigation.verification) {
      this.events.push("execution-persisted");
    }
    if (investigation.verification) {
      this.events.push("verification-persisted");
    }
  }

  getById(id: string): Promise<Investigation | undefined> {
    return this.store.getById(id);
  }
}

class RecordingCodexAdapter implements CodexAdapter {
  readonly repositoryPaths: string[] = [];

  async analyze(request: InvestigationRequest): Promise<CodexAnalysisResult> {
    this.repositoryPaths.push(request.repositoryPath);
    return {
      hypothesis: {
        summary: "Checkout completion calculates one notebook after quantity is set to two.",
        confidence: "high",
        relevantFiles: [{ path: "app/page.tsx", reason: "Renders the quantity input and charged total." }],
        reproductionSteps: ["Open checkout.", "Set Quantity to 2.", "Complete checkout."],
        expectedFailureSignal: "Charged total remains $12.00.",
        assumptions: ["The fixture uses the managed local Playwright base URL."]
      },
      evidence: [{ sourcePath: "app/page.tsx", observation: "The checkout total does not multiply price by quantity." }]
    };
  }

  async generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
    this.repositoryPaths.push(input.request.repositoryPath);
    return { content: generatedCheckoutTest };
  }
}

class RecordingRunnerAdapter implements RunnerAdapter {
  readonly repositoryPaths: string[] = [];
  readonly generatedTestPaths: Array<string | undefined> = [];

  constructor(private readonly output: RunnerOutput) {}

  async run(input: RunnerInput): Promise<RunnerOutput> {
    this.repositoryPaths.push(input.repositoryPath);
    this.generatedTestPaths.push(input.generatedTest.path);
    return this.output;
  }
}

class ThrowingRunnerAdapter implements RunnerAdapter {
  async run(): Promise<RunnerOutput> {
    throw new Error("SMOKE_INTERNAL_RUNNER_FAILURE C:\\smoke-secret-worktree\\runner-stack");
  }
}

function localPartialOutput(): RunnerOutput {
  return {
    execution: {
      command: "controlled_playwright_generated_test",
      exitCode: 1,
      timedOut: false,
      stdout: "Sanitized controlled-run summary.",
      stderr: "",
      durationMs: 1,
      artifacts: []
    },
    evidence: {
      testTitle: "reports the correct total for two notebooks",
      testStatus: "failed",
      assertionFailureMessage: "Expected charged total: $24.00.",
      failureLocation: { file: "tests/generated/failspec.generated.spec.ts", line: 6, column: 3 },
      consoleErrors: ["Checkout total remained $12.00."],
      pageErrors: [],
      artifactPaths: ["test-results/checkout-trace.zip"]
    }
  };
}

function localExecutionErrorOutput(): RunnerOutput {
  return {
    execution: {
      command: "controlled_playwright_generated_test",
      exitCode: null,
      timedOut: true,
      stdout: "",
      stderr: "",
      durationMs: 1,
      artifacts: []
    },
    evidence: {
      testTitle: "reports the correct total for two notebooks",
      testStatus: "timedOut",
      consoleErrors: [],
      pageErrors: [],
      artifactPaths: []
    }
  };
}

function expectStringValuesToExclude(value: unknown, forbiddenValues: readonly string[]): void {
  const stringValues = collectStringValues(value);

  for (const forbiddenValue of forbiddenValues) {
    expect(stringValues.some((stringValue) => stringValue.includes(forbiddenValue))).toBe(false);
  }
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(collectStringValues);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(collectStringValues);
  }
  return [];
}
