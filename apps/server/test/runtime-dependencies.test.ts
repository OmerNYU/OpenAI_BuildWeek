import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockCodexAdapter } from "@failspec/core";
import { createApp } from "../src/app.js";
import { CodexInvestigationAdapter } from "../src/codex/adapter.js";
import type { CodexCliExecutor } from "../src/codex/client.js";
import { createRuntimeDependencies } from "../src/runtime-dependencies.js";
import {
  InProcessWorkflowScheduler,
  type WorkflowScheduler
} from "../src/scheduling/workflow-scheduler.js";

const requestBody = {
  repositoryPath: "C:/repos/checkout-app",
  bugTitle: "Checkout validation is missing",
  bugDescription: "Submitting an empty checkout form does not show an error.",
  expectedBehavior: "A required-field message appears.",
  actualBehavior: "The page does not show validation feedback."
};

const hypothesis = {
  summary: "Checkout does not show the validation error.",
  confidence: "high" as const,
  relevantFiles: [
    { path: "src/checkout.tsx", reason: "It renders the checkout form." }
  ],
  reproductionSteps: ["Open checkout.", "Submit an empty form."],
  expectedFailureSignal: "The required-field message is missing.",
  assumptions: ["The local app starts successfully."]
};

const generatedTestContent =
  "import { expect, test } from '@playwright/test';\n\ntest('shows checkout validation', async ({ page }) => {\n  await page.goto('/checkout');\n  await expect(page.getByText('Required')).toBeVisible();\n});\n";

let storageDirectory: string;

beforeEach(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), "failspec-runtime-dependencies-"));
});

afterEach(async () => {
  await rm(storageDirectory, { recursive: true, force: true });
});

describe("runtime dependency construction", () => {
  it("defaults a missing mode to the deterministic mock adapter", () => {
    const dependencies = createRuntimeDependencies({ investigationDirectory: storageDirectory });

    expect(dependencies.codexAdapter).toBeInstanceOf(MockCodexAdapter);
    expect(dependencies.scheduler).toBeInstanceOf(InProcessWorkflowScheduler);
  });

  it("selects the deterministic mock adapter for explicit mock mode", () => {
    const dependencies = createRuntimeDependencies({
      env: { FAILSPEC_CODEX_MODE: "mock" },
      investigationDirectory: storageDirectory
    });

    expect(dependencies.codexAdapter).toBeInstanceOf(MockCodexAdapter);
  });

  it("constructs the real adapter for local mode with an injected executor", () => {
    const dependencies = createRuntimeDependencies({
      env: { FAILSPEC_CODEX_MODE: "local" },
      codexCliExecutor: createFakeExecutor([analysisJsonl()]),
      investigationDirectory: storageDirectory
    });

    expect(dependencies.codexAdapter).toBeInstanceOf(CodexInvestigationAdapter);
  });

  it("rejects unsupported modes during dependency construction", () => {
    expect(() =>
      createRuntimeDependencies({
        env: { FAILSPEC_CODEX_MODE: "remote" },
        investigationDirectory: storageDirectory
      })
    ).toThrow("Unsupported FAILSPEC_CODEX_MODE");
  });

  it("preserves mock-mode API behavior without invoking a Codex executor", async () => {
    const executor = createFakeExecutor([], "mock mode must not call the executor");
    const scheduler = new ManualWorkflowScheduler();
    const app = createRuntimeApp(
      {
        env: { FAILSPEC_CODEX_MODE: "mock" },
        codexCliExecutor: executor,
        investigationDirectory: storageDirectory
      },
      scheduler
    );

    const response = await request(app).post("/api/investigations").send(requestBody);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("created");
    expect(executor.execute).not.toHaveBeenCalled();
    expect(scheduler.pendingTaskCount).toBe(1);

    await scheduler.runAll();
    const completed = await request(app).get(`/api/investigations/${response.body.id}`);
    expect(completed.body.status).toBe("verified");
    expect(completed.body.hypothesis.summary).toBe("Mock hypothesis for the reported failure.");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("persists local-mode Codex analysis and generated test output from JSONL", async () => {
    const executor = createFakeExecutor([analysisJsonl(), generatedTestJsonl()]);
    const scheduler = new ManualWorkflowScheduler();
    const app = createRuntimeApp(
      {
        env: { FAILSPEC_CODEX_MODE: "local" },
        codexCliExecutor: executor,
        investigationDirectory: storageDirectory
      },
      scheduler
    );

    const response = await request(app).post("/api/investigations").send(requestBody);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("created");
    expect(executor.execute).not.toHaveBeenCalled();

    await scheduler.runAll();
    const completed = await request(app).get(`/api/investigations/${response.body.id}`);
    expect(completed.body.status).toBe("verified");
    expect(completed.body.hypothesis).toEqual(hypothesis);
    expect(completed.body.generatedTestContent).toBe(generatedTestContent);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    const [analysisCall, generationCall] = executor.execute.mock.calls;
    expect(analysisCall?.[0]).toMatchObject({ cwd: requestBody.repositoryPath });
    expect(generationCall?.[0]).toMatchObject({ cwd: requestBody.repositoryPath });
    expect(analysisCall?.[0].prompt).toContain(requestBody.bugTitle);
    expect(generationCall?.[0].prompt).toContain(requestBody.bugTitle);
    expect(generationCall?.[0].prompt).not.toBe(analysisCall?.[0].prompt);
    expect(completed.body.verdictExplanation).toContain("deterministic mock runner");
    expect(completed.body.timeline.at(-1)).toMatchObject({
      status: "verified",
      message: "Mock reproduction verified."
    });

    const reloaded = await request(app).get(`/api/investigations/${response.body.id}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.hypothesis).toEqual(hypothesis);
    expect(reloaded.body.generatedTestContent).toBe(generatedTestContent);
  });

  it("converts local analysis failure to a sanitized execution error", async () => {
    const executor = createFakeExecutor([], "analysis failure at C:/secret/repository");
    const scheduler = new ManualWorkflowScheduler();
    const app = createRuntimeApp(
      {
        env: { FAILSPEC_CODEX_MODE: "local" },
        codexCliExecutor: executor,
        investigationDirectory: storageDirectory
      },
      scheduler
    );

    const response = await request(app).post("/api/investigations").send(requestBody);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("created");
    await scheduler.runAll();
    const completed = await request(app).get(`/api/investigations/${response.body.id}`);
    expect(completed.body.status).toBe("execution_error");
    expect(JSON.stringify(completed.body)).not.toContain("C:/secret/repository");
  });

  it("preserves the local hypothesis when test generation fails", async () => {
    const executor = createFakeExecutor([analysisJsonl()], "generated test failure");
    const scheduler = new ManualWorkflowScheduler();
    const app = createRuntimeApp(
      {
        env: { FAILSPEC_CODEX_MODE: "local" },
        codexCliExecutor: executor,
        investigationDirectory: storageDirectory
      },
      scheduler
    );

    const response = await request(app).post("/api/investigations").send(requestBody);

    expect(response.status).toBe(201);
    expect(response.body.status).toBe("created");
    await scheduler.runAll();
    const completed = await request(app).get(`/api/investigations/${response.body.id}`);
    expect(completed.body.status).toBe("execution_error");
    expect(completed.body.hypothesis).toEqual(hypothesis);
    expect(completed.body.generatedTestContent).toBeUndefined();
  });
});

function createRuntimeApp(
  options: Parameters<typeof createRuntimeDependencies>[0],
  scheduler: WorkflowScheduler
) {
  return createApp({ ...createRuntimeDependencies(options), scheduler });
}

class ManualWorkflowScheduler implements WorkflowScheduler {
  private readonly tasks: Array<() => Promise<void>> = [];

  get pendingTaskCount(): number {
    return this.tasks.length;
  }

  schedule(task: () => Promise<void>): void {
    this.tasks.push(task);
  }

  async runAll(): Promise<void> {
    while (this.tasks.length) {
      await this.tasks.shift()?.();
    }
  }
}

function createFakeExecutor(
  responses: string[],
  failureMessage?: string
): CodexCliExecutor & { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async () => {
      const stdout = responses.shift();
      if (stdout) {
        return { exitCode: 0, stdout, stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: failureMessage ?? "unexpected executor call" };
    })
  };
}

function analysisJsonl(): string {
  return jsonlMessage({
    hypothesis,
    evidence: [
      {
        sourcePath: "src/checkout.tsx",
        observation: "The submit handler does not render an error message."
      }
    ]
  });
}

function generatedTestJsonl(): string {
  return jsonlMessage({ generatedTestContent });
}

function jsonlMessage(value: unknown): string {
  return `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(value) }
  })}\n`;
}
