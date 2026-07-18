import { describe, expect, it } from "vitest";
import type { ExecutionResult, InvestigationRequest, RunnerOutput } from "@failspec/contracts";
import { MockCodexAdapter, MockRunnerAdapter } from "../src/mock-adapters.js";

const request: InvestigationRequest = {
  repositoryPath: "C:/repos/example",
  bugTitle: "Mock failure",
  bugDescription: "The mock scenario fails.",
  expectedBehavior: "The scenario passes.",
  actualBehavior: "The scenario fails."
};

describe("mock adapter boundaries", () => {
  it("returns deterministic analysis evidence and generated test", async () => {
    const adapter = new MockCodexAdapter();
    const firstHypothesis = await adapter.analyze(request);
    const secondHypothesis = await adapter.analyze(request);
    const firstTest = await adapter.generateTest({ request, hypothesis: firstHypothesis.hypothesis });
    const secondTest = await adapter.generateTest({ request, hypothesis: firstHypothesis.hypothesis });

    expect(firstHypothesis).toEqual(secondHypothesis);
    expect(firstHypothesis.hypothesis.summary).toBe("Mock hypothesis for the reported failure.");
    expect(firstHypothesis.evidence).toEqual([]);
    expect(firstTest).toEqual(secondTest);
    expect(firstTest.content).toContain("test('mock'");
    const output = await new MockRunnerAdapter().run({
      repositoryPath: request.repositoryPath,
      generatedTest: firstTest
    });
    expect(output.evidence.artifactPaths).toEqual(output.execution.artifacts);
  });

  it("accepts legacy execution results and returns runner output", async () => {
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
    const generatedTest = await codex.generateTest({ request, hypothesis: hypothesis.hypothesis });
    const runner = new MockRunnerAdapter(result);

    const firstRun = await runner.run({ repositoryPath: request.repositoryPath, generatedTest });
    const secondRun = await runner.run({ repositoryPath: request.repositoryPath, generatedTest });

    expect(firstRun.execution).toBe(result);
    expect(firstRun.evidence).toEqual({
      testStatus: "unknown",
      consoleErrors: [],
      pageErrors: [],
      artifactPaths: ["trace.zip"]
    });
    expect(secondRun).toEqual(firstRun);
  });

  it("returns configured evidence unchanged", async () => {
    const result: RunnerOutput = {
      execution: {
        command: "mock command",
        exitCode: 1,
        timedOut: false,
        stdout: "",
        stderr: "failure",
        durationMs: 1,
        artifacts: []
      },
      evidence: {
        testTitle: "mock",
        testStatus: "failed",
        assertionFailureMessage: "Expected true to be false.",
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: []
      }
    };

    const codex = new MockCodexAdapter();
    const hypothesis = await codex.analyze(request);
    const generatedTest = await codex.generateTest({ request, hypothesis: hypothesis.hypothesis });
    const output = await new MockRunnerAdapter(result).run({
      repositoryPath: request.repositoryPath,
      generatedTest
    });

    expect(output).toBe(result);
  });
});
