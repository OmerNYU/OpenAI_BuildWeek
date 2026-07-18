import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

let storageDirectory: string;

beforeEach(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), "failspec-investigation-"));
});

afterEach(async () => {
  await rm(storageDirectory, { recursive: true, force: true });
});

function createTestApp(overrides: Partial<{
  store: InvestigationStore;
  codexAdapter: CodexAdapter;
  runnerAdapter: RunnerAdapter;
}> = {}) {
  return createApp({
    store: overrides.store ?? new JsonInvestigationStore(storageDirectory),
    codexAdapter: overrides.codexAdapter ?? new MockCodexAdapter(),
    runnerAdapter: overrides.runnerAdapter ?? new MockRunnerAdapter()
  });
}

describe("investigation API", () => {
  it("creates, persists, and returns a verified deterministic investigation", async () => {
    const response = await request(createTestApp())
      .post("/api/investigations")
      .send(validRequest);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("verified");
    expect(response.body.hypothesis.summary).toBe("Mock hypothesis for the reported failure.");
    expect(response.body.generatedTestPath).toBe("tests/failspec.mock.spec.ts");
    expect(response.body.generatedTestContent).toContain("test('mock'");
    expect(response.body.execution).toEqual({
      command: "npx playwright test tests/failspec.mock.spec.ts",
      exitCode: 0,
      timedOut: false,
      stdout: "Mock runner completed.",
      stderr: "",
      durationMs: 1,
      artifacts: []
    });
    expect(response.body.timeline.map((event: { status: string }) => event.status)).toEqual([
      "created",
      "preflight",
      "analyzing",
      "hypothesis_ready",
      "generating_test",
      "test_ready",
      "executing",
      "verified"
    ]);
  });

  it("returns safe validation details for invalid required input", async () => {
    const response = await request(createTestApp())
      .post("/api/investigations")
      .send({ ...validRequest, bugTitle: "   " });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Invalid investigation request.");
    expect(response.body.details).toEqual([
      expect.objectContaining({ field: "bugTitle" })
    ]);
    expect(JSON.stringify(response.body)).not.toContain("ZodError");
  });

  it("retrieves a created investigation from JSON storage", async () => {
    const app = createTestApp();
    const created = await request(app).post("/api/investigations").send(validRequest);
    const retrieved = await request(app).get(`/api/investigations/${created.body.id}`);

    expect(retrieved.status).toBe(200);
    expect(retrieved.body).toEqual(created.body);
  });

  it("returns not found for an unknown investigation", async () => {
    const response = await request(createTestApp())
      .get("/api/investigations/0f3dbf27-7ee6-4d17-bcbc-b0f64e9c46b1");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Investigation not found." });
  });

  it("reloads a JSON record through a new store instance", async () => {
    const app = createTestApp();
    const created = await request(app).post("/api/investigations").send(validRequest);
    const reloaded = await new JsonInvestigationStore(storageDirectory).getById(created.body.id);

    expect(reloaded?.status).toBe("verified");
    expect(reloaded?.generatedTestContent).toBe(created.body.generatedTestContent);
  });

  it("records execution_error when Codex analysis fails", async () => {
    const codexAdapter: CodexAdapter = {
      async analyze(_request: InvestigationRequest): Promise<ReproductionHypothesis> {
        void _request;
        throw new Error("analysis failed");
      },
      async generateTest(_input: GenerateTestInput): Promise<GeneratedTest> {
        void _input;
        throw new Error("not reached");
      }
    };

    const response = await request(createTestApp({ codexAdapter }))
      .post("/api/investigations")
      .send(validRequest);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("execution_error");
    expect(response.body.timeline.at(-1).status).toBe("execution_error");
    expect(response.body.hypothesis).toBeUndefined();
  });

  it("preserves the hypothesis when test generation fails", async () => {
    const codexAdapter: CodexAdapter = {
      async analyze(_request: InvestigationRequest): Promise<ReproductionHypothesis> {
        void _request;
        return mockHypothesis();
      },
      async generateTest(_input: GenerateTestInput): Promise<GeneratedTest> {
        void _input;
        throw new Error("generation failed");
      }
    };

    const response = await request(createTestApp({ codexAdapter }))
      .post("/api/investigations")
      .send(validRequest);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("execution_error");
    expect(response.body.hypothesis.summary).toBe("Test hypothesis.");
    expect(response.body.generatedTestContent).toBeUndefined();
  });

  it("preserves generated evidence when the runner fails", async () => {
    const runnerAdapter: RunnerAdapter = {
      async run(_input: RunnerInput): Promise<RunnerOutput> {
        void _input;
        throw new Error("runner failed");
      }
    };

    const response = await request(createTestApp({ runnerAdapter }))
      .post("/api/investigations")
      .send(validRequest);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("execution_error");
    expect(response.body.hypothesis).toBeDefined();
    expect(response.body.generatedTestPath).toBe("tests/failspec.mock.spec.ts");
    expect(response.body.generatedTestContent).toContain("test('mock'");
    expect(response.body.execution).toBeUndefined();
  });

  it("returns controlled server errors for unexpected store failures", async () => {
    const failingStore: InvestigationStore = {
      async save(_investigation: Investigation): Promise<void> {
        void _investigation;
      },
      async getById(_id: string): Promise<Investigation | undefined> {
        void _id;
        throw new Error("storage unavailable");
      }
    };

    const response = await request(createTestApp({ store: failingStore }))
      .get("/api/investigations/0f3dbf27-7ee6-4d17-bcbc-b0f64e9c46b1");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
  });

  it("returns a controlled error when the first save fails", async () => {
    const failingStore: InvestigationStore = {
      async save(_investigation: Investigation): Promise<void> {
        void _investigation;
        throw new Error("first save failed");
      },
      async getById(_id: string): Promise<Investigation | undefined> {
        void _id;
        return undefined;
      }
    };

    const response = await request(createTestApp({ store: failingStore }))
      .post("/api/investigations")
      .send(validRequest);

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Internal server error" });
  });
});

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
