import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Investigation,
  InvestigationRequest,
  CodexAnalysisResult,
  ReproductionHypothesis,
  RunnerOutput,
  GeneratedTestStagingResult,
  VerificationResult
} from "@failspec/contracts";
import { codexAnalysisResultSchema } from "@failspec/contracts";
import {
  MockCodexAdapter,
  MockRunnerAdapter,
  type CodexAdapter,
  type GenerateTestInput,
  type GeneratedTest,
  type RunnerAdapter,
  type RunnerInput,
  type VerificationInput
} from "@failspec/core";
import { createApp } from "../src/app.js";
import type { WorkflowScheduler } from "../src/scheduling/workflow-scheduler.js";
import {
  PassThroughRepositoryWorkspace,
  type RepositoryWorkspace,
  type RepositoryWorkspaceCleanup,
  type RepositoryWorkspacePreparation
} from "../src/repository/repository-workspace.js";
import { JsonInvestigationStore } from "../src/storage/json-investigation-store.js";
import type { InvestigationStore } from "../src/storage/investigation-store.js";
import type {
  GeneratedTestStager,
  InvestigationRuntimeMode,
  VerificationClassifier
} from "../src/services/investigation-service.js";

const validRequest: InvestigationRequest = {
  repositoryPath: "C:/repos/example",
  bugTitle: "Checkout does not complete",
  bugDescription: "Submitting checkout leaves the user on the same page.",
  expectedBehavior: "A confirmation page appears.",
  actualBehavior: "The user remains on checkout.",
  terminalLog: "Mock console output"
};

const successfulLifecycle = [
  "created",
  "preflight",
  "analyzing",
  "hypothesis_ready",
  "generating_test",
  "test_ready",
  "executing",
  "verified"
];

let storageDirectory: string;

beforeEach(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), "failspec-investigation-"));
});

afterEach(async () => {
  await rm(storageDirectory, { recursive: true, force: true });
});

describe("investigation API", () => {
  it("keeps the mock analysis valid under the shared contract", () => {
    expect(() => codexAnalysisResultSchema.parse(mockAnalysis())).not.toThrow();
  });

  it("returns a created snapshot before the scheduled workflow persists a verified result", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const codexAdapter = new MockCodexAdapter();
    const runnerAdapter = new MockRunnerAdapter();
    const analyze = vi.spyOn(codexAdapter, "analyze");
    const run = vi.spyOn(runnerAdapter, "run");
    const app = createTestApp({ scheduler, codexAdapter, runnerAdapter, repositoryWorkspace });

    const created = await request(app).post("/api/investigations").send(validRequest);

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("created");
    expect(created.body.timeline.map((event: { status: string }) => event.status)).toEqual(["created"]);
    expect(analyze).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(repositoryWorkspace.prepare).not.toHaveBeenCalled();
    expect(scheduler.pendingTaskCount).toBe(1);

    const beforeWorkflow = await request(app).get(`/api/investigations/${created.body.id}`);
    expect(beforeWorkflow.body).toEqual(created.body);

    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("verified");
    expect(completed.body.timeline.map((event: { status: string }) => event.status)).toEqual(successfulLifecycle);
    expect(completed.body.hypothesis.summary).toBe("Mock hypothesis for the reported failure.");
    expect(completed.body.analysisEvidence).toEqual([]);
    expect(completed.body.generatedTestPath).toBe("tests/failspec.mock.spec.ts");
    expect(completed.body.generatedTestContent).toContain("test('mock'");
    expect(completed.body.execution).toEqual(mockExecution());
    expect(completed.body.verdictExplanation).toContain("deterministic mock runner");
    expect(repositoryWorkspace.prepare).toHaveBeenCalledWith(validRequest.repositoryPath, created.body.id);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledWith(created.body.id);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
  });

  it("uses a prepared workspace for adapters and preserves the submitted source path", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const workspacePath = "C:/failspec/worktrees/checkout";
    const repositoryWorkspace = createWorkspace({ workspacePath });
    const codexAdapter = new MockCodexAdapter();
    const runnerAdapter = new MockRunnerAdapter();
    const analyze = vi.spyOn(codexAdapter, "analyze");
    const generateTest = vi.spyOn(codexAdapter, "generateTest");
    const run = vi.spyOn(runnerAdapter, "run");
    const app = createTestApp({ scheduler, repositoryWorkspace, codexAdapter, runnerAdapter });

    const created = await request(app).post("/api/investigations").send(validRequest);
    expect(created.status).toBe(201);
    expect(repositoryWorkspace.prepare).not.toHaveBeenCalled();

    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(repositoryWorkspace.prepare).toHaveBeenCalledWith(validRequest.repositoryPath, created.body.id);
    expect(analyze).toHaveBeenCalledWith(expect.objectContaining({ repositoryPath: workspacePath }));
    expect(generateTest).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ repositoryPath: workspacePath })
    }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ repositoryPath: workspacePath }));
    expect(completed.body.request.repositoryPath).toBe(validRequest.repositoryPath);
    expect(completed.body.status).toBe("verified");
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledWith(created.body.id);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
  });

  it("stages, runs, and classifies a local generated test after cleanup", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const workspacePath = "C:/failspec/worktrees/checkout";
    const repositoryWorkspace = createWorkspace({ workspacePath });
    const stagedContents: string[] = [];
    const stage = vi.fn(async (
      path: string,
      content: string
    ): Promise<GeneratedTestStagingResult> => {
      expect(path).toBe(workspacePath);
      stagedContents.push(content);
      return { status: "staged", stagedTestPath: stagedGeneratedTestPath };
    });
    const runnerAdapter: RunnerAdapter & { run: ReturnType<typeof vi.fn> } = {
      run: vi.fn(async () => localRunnerOutput())
    };
    const classify = vi.fn((input: VerificationInput): VerificationResult => {
      void input;
      return classifiedVerification("not_reproduced");
    });
    const app = createTestApp({
      scheduler,
      repositoryWorkspace,
      generatedTestStager: stage,
      runnerAdapter,
      mode: "local",
      verificationClassifier: classify
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(stage).toHaveBeenCalledWith(workspacePath, expect.any(String));
    expect(stagedContents[0]).toContain("test('mock'");
    expect(runnerAdapter.run).toHaveBeenCalledWith({
      repositoryPath: workspacePath,
      generatedTest: { content: stagedContents[0], path: stagedGeneratedTestPath }
    });
    expect(stage.mock.invocationCallOrder[0]).toBeLessThan(runnerAdapter.run.mock.invocationCallOrder[0]);
    expect(completed.body.status).toBe("not_reproduced");
    expect(completed.body.timeline.map((event: { status: string }) => event.status)).toEqual([
      "created",
      "preflight",
      "analyzing",
      "hypothesis_ready",
      "generating_test",
      "test_ready",
      "executing",
      "not_reproduced"
    ]);
    expect(completed.body.request.repositoryPath).toBe(validRequest.repositoryPath);
    expect(completed.body.generatedTestPath).toBe(stagedGeneratedTestPath);
    expect(completed.body.execution).toEqual(localRunnerOutput().execution);
    expect(completed.body.executionEvidence).toEqual(localRunnerOutput().evidence);
    expect(completed.body.verification).toEqual(classifiedVerification("not_reproduced"));
    expect(completed.body.verdictExplanation).toBe(classifiedVerification("not_reproduced").explanation);
    expect(classify).toHaveBeenCalledWith({
      hypothesis: expect.objectContaining({ summary: "Mock hypothesis for the reported failure." }),
      execution: localRunnerOutput().execution,
      evidence: localRunnerOutput().evidence
    });
    expect(runnerAdapter.run.mock.invocationCallOrder[0]).toBeLessThan(repositoryWorkspace.cleanup.mock.invocationCallOrder[0]);
    expect(repositoryWorkspace.cleanup.mock.invocationCallOrder[0]).toBeLessThan(classify.mock.invocationCallOrder[0]);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledWith(created.body.id);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails safely when classification throws after cleanup", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const classify = vi.fn(() => { throw new Error("C:/secret/worktree/classifier failure"); });
    const app = createTestApp({
      scheduler,
      repositoryWorkspace,
      runnerAdapter: new MockRunnerAdapter(localRunnerOutput()),
      generatedTestStager: successfulGeneratedTestStager,
      verificationClassifier: classify
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.verification).toBeUndefined();
    expect(completed.body.execution).toEqual(localRunnerOutput().execution);
    expect(completed.body.executionEvidence).toEqual(localRunnerOutput().evidence);
    expect(completed.body.verdictExplanation).toContain("could not be classified safely");
    expect(JSON.stringify(completed.body)).not.toContain("C:/secret/worktree");
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails safely when classification returns malformed sensitive output", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const classify = vi.fn(() => ({
      verdict: "invalid-verdict",
      explanation: "C:/secret/worktree/schema detail",
      recommendedNextStep: "internal classifier detail",
      supportingSignals: [{ type: "", message: "C:/secret/worktree/signal" }]
    }) as unknown as VerificationResult);
    const app = createTestApp({
      scheduler,
      repositoryWorkspace,
      runnerAdapter: new MockRunnerAdapter(localRunnerOutput()),
      generatedTestStager: successfulGeneratedTestStager,
      verificationClassifier: classify
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(classify).toHaveBeenCalledTimes(1);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.verification).toBeUndefined();
    expect(completed.body.execution).toEqual(localRunnerOutput().execution);
    expect(completed.body.executionEvidence).toEqual(localRunnerOutput().evidence);
    expect(completed.body.verdictExplanation).toContain("The execution evidence could not be classified safely.");
    expect(JSON.stringify(completed.body)).not.toContain("invalid-verdict");
    expect(JSON.stringify(completed.body)).not.toContain("C:/secret/worktree");
  });

  it("persists execution evidence before cleanup and verification after classification", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const events: string[] = [];
    const records = new Map<string, Investigation>();
    const store: InvestigationStore = {
      async save(investigation) {
        events.push(investigation.verification ? "terminal-save" : investigation.execution ? "execution-save" : "save");
        records.set(investigation.id, structuredClone(investigation));
      },
      async getById(id) { return records.get(id); }
    };
    const repositoryWorkspace = createWorkspace({
      cleanup: { status: "cleaned" }
    });
    repositoryWorkspace.cleanup.mockImplementation(async () => {
      events.push("cleanup");
      return { status: "cleaned" };
    });
    const runnerAdapter: RunnerAdapter = {
      async run() {
        events.push("runner");
        return localRunnerOutput();
      }
    };
    const classify = vi.fn((input: VerificationInput) => {
      events.push("classifier");
      expect(input.execution).toEqual(localRunnerOutput().execution);
      expect(input.evidence).toEqual(localRunnerOutput().evidence);
      return classifiedVerification("not_reproduced");
    });
    const app = createTestApp({ store, scheduler, repositoryWorkspace, runnerAdapter, generatedTestStager: successfulGeneratedTestStager, verificationClassifier: classify });

    await request(app).post("/api/investigations").send(validRequest).then(() => scheduler.runNext());

    expect(events.filter((event) => ["runner", "execution-save", "cleanup", "classifier", "terminal-save"].includes(event))).toEqual([
      "runner", "execution-save", "cleanup", "classifier", "terminal-save"
    ]);
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it.each(["partial", "execution_error"] as const)("persists a valid classified %s terminal result", async (verdict) => {
    const scheduler = new ManualWorkflowScheduler();
    const app = createTestApp({
      scheduler,
      runnerAdapter: new MockRunnerAdapter(localRunnerOutput()),
      generatedTestStager: successfulGeneratedTestStager,
      verificationClassifier: () => classifiedVerification(verdict)
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe(verdict);
    expect(completed.body.verification).toEqual(classifiedVerification(verdict));
    expect(completed.body.verdictExplanation).toBe(classifiedVerification(verdict).explanation);
    expect(completed.body.recommendedNextStep).toBe(classifiedVerification(verdict).recommendedNextStep);
    expect(completed.body.timeline.at(-1)).toMatchObject({
      status: verdict,
      message: verdict === "partial"
        ? "Investigation completed with partial evidence."
        : "Execution evidence could not be classified as a valid reproduction."
    });
  });

  it("persists an intermediate analyzing state while Codex analysis is still active", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const analysisStarted = deferred<void>();
    const hypothesis = deferred<CodexAnalysisResult>();
    const mockCodexAdapter = new MockCodexAdapter();
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<CodexAnalysisResult> {
        analysisStarted.resolve(undefined);
        return hypothesis.promise;
      },
      generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
        return mockCodexAdapter.generateTest(input);
      }
    };
    const app = createTestApp({ scheduler, codexAdapter });

    const created = await request(app).post("/api/investigations").send(validRequest);

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("created");
    expect(scheduler.pendingTaskCount).toBe(1);
    const task = scheduler.takeNext();
    if (!task) {
      throw new Error("Expected a scheduled workflow task.");
    }
    const workflow = task();
    await analysisStarted.promise;

    const intermediate = await request(app).get(`/api/investigations/${created.body.id}`);
    expect(intermediate.body.status).toBe("analyzing");
    expect(intermediate.body.timeline.at(-1).status).toBe("analyzing");
    expect(intermediate.body.hypothesis).toBeUndefined();

    hypothesis.resolve(mockAnalysis());
    await workflow;
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("verified");
    expect(completed.body.timeline.map((event: { status: string }) => event.status)).toEqual(successfulLifecycle);
    expect(completed.body.hypothesis).toEqual(mockHypothesis());
    expect(completed.body.analysisEvidence).toEqual(mockAnalysis().evidence);
    expect(completed.body.generatedTestPath).toBe("tests/failspec.mock.spec.ts");
    expect(completed.body.generatedTestContent).toContain("test('mock'");
    expect(completed.body.execution).toEqual(mockExecution());
    expect(completed.body.verdictExplanation).toContain("deterministic mock runner");
  });

  it("keeps the creation response created when an immediate scheduler invokes the workflow", async () => {
    const scheduler = new ImmediateWorkflowScheduler();
    const app = createTestApp({ scheduler });

    const created = await request(app).post("/api/investigations").send(validRequest);

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("created");
    expect(created.body.timeline.map((event: { status: string }) => event.status)).toEqual(["created"]);

    await scheduler.waitForTask();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);
    expect(completed.body.status).toBe("verified");
  });

  it("returns safe validation details for invalid required input", async () => {
    const response = await request(createTestApp())
      .post("/api/investigations")
      .send({ ...validRequest, bugTitle: "   " });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid investigation request.");
    expect(response.body.details).toEqual([expect.objectContaining({ field: "bugTitle" })]);
    expect(JSON.stringify(response.body)).not.toContain("ZodError");
  });

  it("retrieves the persisted created investigation before its workflow runs", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const app = createTestApp({ scheduler });
    const created = await request(app).post("/api/investigations").send(validRequest);
    const retrieved = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(retrieved.status).toBe(200);
    expect(retrieved.body).toEqual(created.body);
    expect(retrieved.body.status).toBe("created");
  });

  it("reloads a completed JSON record through a new store instance", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const mockCodexAdapter = new MockCodexAdapter();
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<CodexAnalysisResult> {
        return mockAnalysis();
      },
      generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
        return mockCodexAdapter.generateTest(input);
      }
    };
    const app = createTestApp({ scheduler, codexAdapter });
    const created = await request(app).post("/api/investigations").send(validRequest);

    await scheduler.runAll();
    const reloaded = await new JsonInvestigationStore(storageDirectory).getById(created.body.id);

    expect(reloaded?.status).toBe("verified");
    expect(reloaded?.analysisEvidence).toEqual(mockAnalysis().evidence);
    expect(reloaded?.generatedTestContent).toContain("test('mock'");
  });

  it("returns not found for an unknown investigation", async () => {
    const response = await request(createTestApp())
      .get("/api/investigations/0f3dbf27-7ee6-4d17-bcbc-b0f64e9c46b1");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Investigation not found." });
  });

  it("records execution_error without a hypothesis when analysis fails", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const classify = vi.fn(mockVerificationClassifier);
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<CodexAnalysisResult> {
        throw new Error("analysis failed");
      },
      async generateTest(_input: GenerateTestInput): Promise<GeneratedTest> {
        void _input;
        throw new Error("not reached");
      }
    };
    const app = createTestApp({ scheduler, codexAdapter, repositoryWorkspace, verificationClassifier: classify });

    const created = await request(app).post("/api/investigations").send(validRequest);
    expect(created.body.status).toBe("created");
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.timeline.at(-1).status).toBe("execution_error");
    expect(completed.body.hypothesis).toBeUndefined();
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it("preserves the hypothesis when test generation fails", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const classify = vi.fn(mockVerificationClassifier);
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<CodexAnalysisResult> {
        return mockAnalysis();
      },
      async generateTest(_input: GenerateTestInput): Promise<GeneratedTest> {
        void _input;
        throw new Error("generation failed");
      }
    };
    const app = createTestApp({ scheduler, codexAdapter, repositoryWorkspace, verificationClassifier: classify });

    const created = await request(app).post("/api/investigations").send(validRequest);
    expect(created.body.status).toBe("created");
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.hypothesis.summary).toBe("Test hypothesis.");
    expect(completed.body.analysisEvidence).toEqual(mockAnalysis().evidence);
    expect(completed.body.generatedTestContent).toBeUndefined();
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it("preserves generated test information when the runner fails", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const classify = vi.fn(mockVerificationClassifier);
    const mockCodexAdapter = new MockCodexAdapter();
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<CodexAnalysisResult> {
        return mockAnalysis();
      },
      generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
        return mockCodexAdapter.generateTest(input);
      }
    };
    const runnerAdapter: RunnerAdapter = {
      async run(_input: RunnerInput): Promise<RunnerOutput> {
        void _input;
        throw new Error("runner failed");
      }
    };
    const app = createTestApp({
      scheduler,
      codexAdapter,
      runnerAdapter,
      repositoryWorkspace,
      generatedTestStager: successfulGeneratedTestStager,
      mode: "local",
      verificationClassifier: classify
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    expect(created.body.status).toBe("created");
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.hypothesis).toBeDefined();
    expect(completed.body.analysisEvidence).toEqual(mockAnalysis().evidence);
    expect(completed.body.generatedTestPath).toBe(stagedGeneratedTestPath);
    expect(completed.body.generatedTestContent).toContain("test('mock'");
    expect(completed.body.execution).toBeUndefined();
    expect(completed.body.executionEvidence).toBeUndefined();
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    { status: "rejected" as const, failure: { code: "disallowed_api" as const } },
    { status: "failed" as const, failure: { code: "write_failed" as const } }
  ])("preserves generated content and skips execution when staging $status", async (stagingResult) => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const generatedTestStager: GeneratedTestStager = async () => stagingResult;
    const runnerAdapter = new MockRunnerAdapter();
    const run = vi.spyOn(runnerAdapter, "run");
    const classify = vi.fn(mockVerificationClassifier);
    const app = createTestApp({
      scheduler,
      repositoryWorkspace,
      generatedTestStager,
      runnerAdapter,
      mode: "local",
      verificationClassifier: classify
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.hypothesis.summary).toBe("Mock hypothesis for the reported failure.");
    expect(completed.body.analysisEvidence).toEqual([]);
    expect(completed.body.generatedTestContent).toContain("test('mock'");
    expect(completed.body.generatedTestPath).toBeUndefined();
    expect(completed.body.execution).toBeUndefined();
    expect(completed.body.timeline.map((event: { status: string }) => event.status)).not.toContain("test_ready");
    expect(run).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
    expect(JSON.stringify(completed.body)).not.toContain(stagingResult.failure.code);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a runner returns malformed output", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const classify = vi.fn(mockVerificationClassifier);
    const runnerAdapter: RunnerAdapter = {
      async run(_input: RunnerInput): Promise<RunnerOutput> {
        void _input;
        return { execution: localRunnerOutput().execution } as RunnerOutput;
      }
    };
    const app = createTestApp({
      scheduler,
      repositoryWorkspace,
      generatedTestStager: successfulGeneratedTestStager,
      runnerAdapter,
      mode: "local",
      verificationClassifier: classify
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.generatedTestPath).toBe(stagedGeneratedTestPath);
    expect(completed.body.execution).toBeUndefined();
    expect(completed.body.executionEvidence).toBeUndefined();
    expect(completed.body.verdictExplanation).toContain("returned invalid results");
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([
    localRunnerOutput({ timedOut: true, testStatus: "timedOut" }),
    localRunnerOutput({ timedOut: false, testStatus: "interrupted" }),
    localRunnerOutput({
      timedOut: true,
      testStatus: "timedOut",
      stdout: "Controlled Playwright cleanup failed.",
      stderr: "Controlled process cleanup failed."
    })
  ])("preserves returned execution facts and evidence without assigning a verdict", async (output) => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const runnerAdapter = new MockRunnerAdapter(output);
    const app = createTestApp({
      scheduler,
      repositoryWorkspace,
      generatedTestStager: successfulGeneratedTestStager,
      runnerAdapter,
      mode: "local",
      verificationClassifier: () => classifiedVerification("execution_error")
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.execution).toEqual(output.execution);
    expect(completed.body.executionEvidence).toEqual(output.evidence);
    expect(completed.body.verification).toEqual(classifiedVerification("execution_error"));
    expect(completed.body.verdictExplanation).toBe(classifiedVerification("execution_error").explanation);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not run adapters or cleanup when workspace preparation fails", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace({
      preparation: { status: "failed", message: "internal preflight failure" }
    });
    const codexAdapter = new MockCodexAdapter();
    const runnerAdapter = new MockRunnerAdapter();
    const analyze = vi.spyOn(codexAdapter, "analyze");
    const run = vi.spyOn(runnerAdapter, "run");
    const classify = vi.fn(mockVerificationClassifier);
    const app = createTestApp({
      scheduler,
      repositoryWorkspace,
      codexAdapter,
      runnerAdapter,
      verificationClassifier: classify
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.verdictExplanation).toContain("repository could not be prepared safely");
    expect(JSON.stringify(completed.body)).not.toContain("internal preflight failure");
    expect(analyze).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(repositoryWorkspace.cleanup).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("does not verify when workspace cleanup fails after the runner succeeds", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace({
      cleanup: { status: "failed", message: "cleanup internals" }
    });
    const classify = vi.fn(mockVerificationClassifier);
    const app = createTestApp({
      scheduler,
      repositoryWorkspace,
      generatedTestStager: successfulGeneratedTestStager,
      mode: "local",
      verificationClassifier: classify
    });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.timeline.map((event: { status: string }) => event.status)).not.toContain("verified");
    expect(completed.body.execution).toEqual(mockExecution());
    expect(completed.body.executionEvidence).toEqual(mockRunnerOutput().evidence);
    expect(completed.body.verification).toBeUndefined();
    expect(completed.body.verdictExplanation).toContain("could not be cleaned up safely");
    expect(JSON.stringify(completed.body)).not.toContain("cleanup internals");
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
    expect(classify).not.toHaveBeenCalled();
  });

  it("attempts cleanup once and keeps workflow failures sanitized when both steps fail", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace({
      cleanup: { status: "failed", message: "cleanup internals" }
    });
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<CodexAnalysisResult> {
        throw new Error("analysis internals");
      },
      async generateTest(_input: GenerateTestInput): Promise<GeneratedTest> {
        void _input;
        throw new Error("not reached");
      }
    };
    const app = createTestApp({ scheduler, repositoryWorkspace, codexAdapter });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.verdictExplanation).toContain("Investigation workflow failed.");
    expect(JSON.stringify(completed.body)).not.toContain("analysis internals");
    expect(JSON.stringify(completed.body)).not.toContain("cleanup internals");
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
  });

  it("attempts cleanup when persistence fails after workspace preparation", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const repositoryWorkspace = createWorkspace();
    const records = new Map<string, Investigation>();
    let saveCount = 0;
    const store: InvestigationStore = {
      async save(investigation: Investigation): Promise<void> {
        saveCount += 1;
        if (saveCount === 3) {
          throw new Error("persistence internals");
        }
        records.set(investigation.id, structuredClone(investigation));
      },
      async getById(id: string): Promise<Investigation | undefined> {
        const record = records.get(id);
        return record && structuredClone(record);
      }
    };
    const app = createTestApp({ scheduler, repositoryWorkspace, store });

    const created = await request(app).post("/api/investigations").send(validRequest);
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledWith(created.body.id);
    expect(repositoryWorkspace.cleanup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(completed.body)).not.toContain("persistence internals");
  });

  it("does not schedule when the initial persistence fails", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const failingStore: InvestigationStore = {
      async save(): Promise<void> {
        throw new Error("first save failed");
      },
      async getById(): Promise<Investigation | undefined> {
        return undefined;
      }
    };

    const response = await request(createTestApp({ store: failingStore, scheduler }))
      .post("/api/investigations")
      .send(validRequest);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
    expect(scheduler.pendingTaskCount).toBe(0);
  });

  it("runs independently scheduled investigations without updating the other record", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const workspacePaths = new Map<string, string>();
    const repositoryWorkspace: RepositoryWorkspace & {
      prepare: ReturnType<typeof vi.fn>;
      cleanup: ReturnType<typeof vi.fn>;
    } = {
      prepare: vi.fn(async (sourceRepositoryPath: string, investigationId: string) => {
        const workspacePath = `C:/failspec/worktrees/${investigationId}`;
        workspacePaths.set(investigationId, workspacePath);
        return {
          status: "prepared" as const,
          workspace: { sourceRepositoryPath, workspacePath }
        };
      }),
      cleanup: vi.fn(async () => ({ status: "cleaned" as const }))
    };
    const runnerAdapter = new MockRunnerAdapter();
    const run = vi.spyOn(runnerAdapter, "run");
    const app = createTestApp({ scheduler, repositoryWorkspace, runnerAdapter });
    const first = await request(app).post("/api/investigations").send(validRequest);
    const second = await request(app)
      .post("/api/investigations")
      .send({ ...validRequest, bugTitle: "Checkout does not validate" });

    expect(first.body.id).not.toBe(second.body.id);
    expect(scheduler.pendingTaskCount).toBe(2);

    await scheduler.runNext();
    const firstCompleted = await request(app).get(`/api/investigations/${first.body.id}`);
    const secondPending = await request(app).get(`/api/investigations/${second.body.id}`);
    expect(firstCompleted.body.status).toBe("verified");
    expect(secondPending.body.status).toBe("created");

    await scheduler.runNext();
    const secondCompleted = await request(app).get(`/api/investigations/${second.body.id}`);
    expect(secondCompleted.body.status).toBe("verified");
    expect(repositoryWorkspace.prepare).toHaveBeenNthCalledWith(
      1,
      validRequest.repositoryPath,
      first.body.id
    );
    expect(repositoryWorkspace.prepare).toHaveBeenNthCalledWith(
      2,
      validRequest.repositoryPath,
      second.body.id
    );
    expect(run).toHaveBeenNthCalledWith(1, expect.objectContaining({
      repositoryPath: workspacePaths.get(first.body.id)
    }));
    expect(run).toHaveBeenNthCalledWith(2, expect.objectContaining({
      repositoryPath: workspacePaths.get(second.body.id)
    }));
    expect(repositoryWorkspace.cleanup).toHaveBeenNthCalledWith(1, first.body.id);
    expect(repositoryWorkspace.cleanup).toHaveBeenNthCalledWith(2, second.body.id);
  });

  it("returns controlled server errors for unexpected store failures", async () => {
    const failingStore: InvestigationStore = {
      async save(): Promise<void> {},
      async getById(): Promise<Investigation | undefined> {
        throw new Error("storage unavailable");
      }
    };

    const response = await request(createTestApp({ store: failingStore }))
      .get("/api/investigations/0f3dbf27-7ee6-4d17-bcbc-b0f64e9c46b1");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
  });
});

function createTestApp(overrides: Partial<{
  store: InvestigationStore;
  codexAdapter: CodexAdapter;
  runnerAdapter: RunnerAdapter;
  scheduler: WorkflowScheduler;
  repositoryWorkspace: RepositoryWorkspace;
  generatedTestStager: GeneratedTestStager;
  verificationClassifier: VerificationClassifier;
  mode: InvestigationRuntimeMode;
}> = {}) {
  return createApp({
    store: overrides.store ?? new JsonInvestigationStore(storageDirectory),
    codexAdapter: overrides.codexAdapter ?? new MockCodexAdapter(),
    runnerAdapter: overrides.runnerAdapter ?? new MockRunnerAdapter(),
    scheduler: overrides.scheduler ?? new ManualWorkflowScheduler(),
    repositoryWorkspace: overrides.repositoryWorkspace ?? new PassThroughRepositoryWorkspace(),
    generatedTestStager: overrides.generatedTestStager ?? mockGeneratedTestStager,
    verificationClassifier: overrides.verificationClassifier ?? mockVerificationClassifier,
    mode: overrides.mode ?? "mock"
  });
}

const mockGeneratedTestStager: GeneratedTestStager = async (
  workspacePath: string,
  content: string
): Promise<GeneratedTestStagingResult> => {
  void workspacePath;
  void content;
  return { status: "staged", stagedTestPath: "tests/failspec.mock.spec.ts" };
};

const mockVerificationClassifier: VerificationClassifier = () => ({
  verdict: "verified",
  explanation: "The deterministic mock runner returned the expected reproduction signal.",
  recommendedNextStep: "Review the generated regression test before running it against a real repository.",
  supportingSignals: [{ type: "mock_verification", message: "Deterministic mock verification completed." }]
});

function classifiedVerification(verdict: VerificationResult["verdict"]): VerificationResult {
  return {
    verdict,
    explanation: `Classifier explanation for ${verdict}.`,
    recommendedNextStep: `Classifier next step for ${verdict}.`,
    supportingSignals: [{ type: "classifier", message: `Classifier signal for ${verdict}.` }]
  };
}

const stagedGeneratedTestPath = "tests/generated/failspec.generated.spec.ts";

const successfulGeneratedTestStager: GeneratedTestStager = async (
  workspacePath: string,
  content: string
) => {
  void workspacePath;
  void content;
  return { status: "staged", stagedTestPath: stagedGeneratedTestPath };
};

function createWorkspace(options: {
  workspacePath?: string;
  preparation?: RepositoryWorkspacePreparation;
  cleanup?: RepositoryWorkspaceCleanup;
} = {}): RepositoryWorkspace & {
  prepare: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
} {
  const workspacePath = options.workspacePath ?? validRequest.repositoryPath;
  return {
    prepare: vi.fn(async (sourceRepositoryPath: string) => options.preparation ?? ({
      status: "prepared",
      workspace: { sourceRepositoryPath, workspacePath }
    })),
    cleanup: vi.fn(async () => options.cleanup ?? ({ status: "cleaned" }))
  };
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
    const task = this.takeNext();
    if (!task) {
      throw new Error("No scheduled workflow task is pending.");
    }
    await task();
  }

  takeNext(): (() => Promise<void>) | undefined {
    return this.tasks.shift();
  }

  async runAll(): Promise<void> {
    while (this.tasks.length) {
      await this.runNext();
    }
  }
}

class ImmediateWorkflowScheduler implements WorkflowScheduler {
  private taskPromise: Promise<void> | undefined;

  schedule(task: () => Promise<void>): void {
    this.taskPromise = task();
  }

  async waitForTask(): Promise<void> {
    await this.taskPromise;
  }
}

function mockHypothesis(): ReproductionHypothesis {
  return {
    summary: "Test hypothesis.",
    confidence: "medium",
    relevantFiles: [
      {
        path: "src/checkout.tsx",
        reason: "Contains the checkout submit handler under investigation."
      }
    ],
    reproductionSteps: ["Run the mock scenario."],
    expectedFailureSignal: "Mock failure signal.",
    assumptions: []
  };
}

function mockAnalysis(): CodexAnalysisResult {
  return {
    hypothesis: mockHypothesis(),
    evidence: [
      {
        sourcePath: "src/checkout.tsx",
        observation: "The submit handler lacks an error state."
      }
    ]
  };
}

function mockExecution() {
  return {
    command: "npx playwright test tests/failspec.mock.spec.ts",
    exitCode: 0,
    timedOut: false,
    stdout: "Mock runner completed.",
    stderr: "",
    durationMs: 1,
    artifacts: []
  };
}

function mockRunnerOutput(): RunnerOutput {
  return {
    execution: mockExecution(),
    evidence: {
      testTitle: "Mock regression test",
      testStatus: "passed",
      consoleErrors: [],
      pageErrors: [],
      artifactPaths: []
    }
  };
}

function localRunnerOutput(options: Partial<{
  timedOut: boolean;
  testStatus: NonNullable<RunnerOutput["evidence"]["testStatus"]>;
  stdout: string;
  stderr: string;
}> = {}): RunnerOutput {
  return {
    execution: {
      command: "controlled_playwright_generated_test",
      exitCode: null,
      timedOut: options.timedOut ?? false,
      stdout: options.stdout ?? "Playwright execution completed.",
      stderr: options.stderr ?? "",
      durationMs: 1,
      artifacts: []
    },
    evidence: {
      testStatus: options.testStatus ?? "passed",
      consoleErrors: [],
      pageErrors: [],
      artifactPaths: []
    }
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
