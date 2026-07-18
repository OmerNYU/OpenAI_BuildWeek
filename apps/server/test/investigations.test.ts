import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Investigation,
  InvestigationRequest,
  ReproductionHypothesis,
  RunnerOutput
} from "@failspec/contracts";
import {
  MockCodexAdapter,
  MockRunnerAdapter,
  type CodexAdapter,
  type GenerateTestInput,
  type GeneratedTest,
  type RunnerAdapter,
  type RunnerInput
} from "@failspec/core";
import { createApp } from "../src/app.js";
import type { WorkflowScheduler } from "../src/scheduling/workflow-scheduler.js";
import { JsonInvestigationStore } from "../src/storage/json-investigation-store.js";
import type { InvestigationStore } from "../src/storage/investigation-store.js";

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
  it("returns a created snapshot before the scheduled workflow persists a verified result", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const codexAdapter = new MockCodexAdapter();
    const runnerAdapter = new MockRunnerAdapter();
    const analyze = vi.spyOn(codexAdapter, "analyze");
    const run = vi.spyOn(runnerAdapter, "run");
    const app = createTestApp({ scheduler, codexAdapter, runnerAdapter });

    const created = await request(app).post("/api/investigations").send(validRequest);

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("created");
    expect(created.body.timeline.map((event: { status: string }) => event.status)).toEqual(["created"]);
    expect(analyze).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(scheduler.pendingTaskCount).toBe(1);

    const beforeWorkflow = await request(app).get(`/api/investigations/${created.body.id}`);
    expect(beforeWorkflow.body).toEqual(created.body);

    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("verified");
    expect(completed.body.timeline.map((event: { status: string }) => event.status)).toEqual(successfulLifecycle);
    expect(completed.body.hypothesis.summary).toBe("Mock hypothesis for the reported failure.");
    expect(completed.body.generatedTestPath).toBe("tests/failspec.mock.spec.ts");
    expect(completed.body.generatedTestContent).toContain("test('mock'");
    expect(completed.body.execution).toEqual(mockExecution());
    expect(completed.body.verdictExplanation).toContain("deterministic mock runner");
  });

  it("persists an intermediate analyzing state while Codex analysis is still active", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const analysisStarted = deferred<void>();
    const hypothesis = deferred<ReproductionHypothesis>();
    const mockCodexAdapter = new MockCodexAdapter();
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<ReproductionHypothesis> {
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

    hypothesis.resolve(mockHypothesis());
    await workflow;
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("verified");
    expect(completed.body.timeline.map((event: { status: string }) => event.status)).toEqual(successfulLifecycle);
    expect(completed.body.hypothesis).toEqual(mockHypothesis());
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
    const app = createTestApp({ scheduler });
    const created = await request(app).post("/api/investigations").send(validRequest);

    await scheduler.runAll();
    const reloaded = await new JsonInvestigationStore(storageDirectory).getById(created.body.id);

    expect(reloaded?.status).toBe("verified");
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
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<ReproductionHypothesis> {
        throw new Error("analysis failed");
      },
      async generateTest(_input: GenerateTestInput): Promise<GeneratedTest> {
        void _input;
        throw new Error("not reached");
      }
    };
    const app = createTestApp({ scheduler, codexAdapter });

    const created = await request(app).post("/api/investigations").send(validRequest);
    expect(created.body.status).toBe("created");
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.timeline.at(-1).status).toBe("execution_error");
    expect(completed.body.hypothesis).toBeUndefined();
  });

  it("preserves the hypothesis when test generation fails", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const codexAdapter: CodexAdapter = {
      async analyze(): Promise<ReproductionHypothesis> {
        return mockHypothesis();
      },
      async generateTest(_input: GenerateTestInput): Promise<GeneratedTest> {
        void _input;
        throw new Error("generation failed");
      }
    };
    const app = createTestApp({ scheduler, codexAdapter });

    const created = await request(app).post("/api/investigations").send(validRequest);
    expect(created.body.status).toBe("created");
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.hypothesis.summary).toBe("Test hypothesis.");
    expect(completed.body.generatedTestContent).toBeUndefined();
  });

  it("preserves generated test information when the runner fails", async () => {
    const scheduler = new ManualWorkflowScheduler();
    const runnerAdapter: RunnerAdapter = {
      async run(_input: RunnerInput): Promise<RunnerOutput> {
        void _input;
        throw new Error("runner failed");
      }
    };
    const app = createTestApp({ scheduler, runnerAdapter });

    const created = await request(app).post("/api/investigations").send(validRequest);
    expect(created.body.status).toBe("created");
    await scheduler.runNext();
    const completed = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.hypothesis).toBeDefined();
    expect(completed.body.generatedTestPath).toBe("tests/failspec.mock.spec.ts");
    expect(completed.body.generatedTestContent).toContain("test('mock'");
    expect(completed.body.execution).toBeUndefined();
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
    const app = createTestApp({ scheduler });
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
}> = {}) {
  return createApp({
    store: overrides.store ?? new JsonInvestigationStore(storageDirectory),
    codexAdapter: overrides.codexAdapter ?? new MockCodexAdapter(),
    runnerAdapter: overrides.runnerAdapter ?? new MockRunnerAdapter(),
    scheduler: overrides.scheduler ?? new ManualWorkflowScheduler()
  });
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
    relevantFiles: [],
    reproductionSteps: ["Run the mock scenario."],
    expectedFailureSignal: "Mock failure signal.",
    assumptions: []
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
