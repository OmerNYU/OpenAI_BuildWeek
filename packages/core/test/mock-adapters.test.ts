import { describe, expect, it } from "vitest";
import type { ExecutionResult, InvestigationRequest } from "@failspec/contracts";
import { MockCodexAdapter, MockRunnerAdapter } from "../src/mock-adapters.js";

const request: InvestigationRequest = {
  repositoryPath: "C:/repos/example",
  bugTitle: "Mock failure",
  bugDescription: "The mock scenario fails.",
  expectedBehavior: "The scenario passes.",
  actualBehavior: "The scenario fails."
};

describe("mock adapter boundaries", () => {
  it("returns a deterministic hypothesis and generated test", async () => {
    const adapter = new MockCodexAdapter();
    const firstHypothesis = await adapter.analyze(request);
    const secondHypothesis = await adapter.analyze(request);
    const firstTest = await adapter.generateTest({ request, hypothesis: firstHypothesis });
    const secondTest = await adapter.generateTest({ request, hypothesis: firstHypothesis });

    expect(firstHypothesis).toEqual(secondHypothesis);
    expect(firstHypothesis.summary).toBe("Mock hypothesis for the reported failure.");
    expect(firstTest).toEqual(secondTest);
    expect(firstTest.content).toContain("test('mock'");
  });

  it("accepts repository context and returns the configured execution result unchanged", async () => {
    const result: ExecutionResult = {
      command: "mock command",
      exitCode: 1,
      timedOut: false,
      stdout: "stdout",
      stderr: "stderr",
      durationMs: 42,
      artifacts: ["trace.zip"]
    };
    const codex = new MockCodexAdapter();
    const hypothesis = await codex.analyze(request);
    const generatedTest = await codex.generateTest({ request, hypothesis });
    const runner = new MockRunnerAdapter(result);

    const firstRun = await runner.run({ repositoryPath: request.repositoryPath, generatedTest });
    const secondRun = await runner.run({ repositoryPath: request.repositoryPath, generatedTest });

    expect(firstRun).toBe(result);
    expect(secondRun).toEqual(firstRun);
  });
});
