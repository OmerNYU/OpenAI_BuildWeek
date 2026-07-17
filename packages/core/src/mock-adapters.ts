import type {
  ExecutionResult,
  InvestigationRequest,
  ReproductionHypothesis
} from "@failspec/contracts";
import type { CodexAdapter, GenerateTestInput, GeneratedTest, RunnerAdapter, RunnerInput } from "./adapters.js";

const mockHypothesis: ReproductionHypothesis = {
  summary: "Mock hypothesis for the reported failure.",
  confidence: "medium",
  relevantFiles: [],
  reproductionSteps: ["Run the deterministic mock scenario."],
  expectedFailureSignal: "Mock failure signal.",
  assumptions: ["No repository inspection was performed."]
};

const mockGeneratedTest: GeneratedTest = {
  path: "tests/failspec.mock.spec.ts",
  content: "import { expect, test } from '@playwright/test';\ntest('mock', () => expect(true).toBe(true));\n"
};

export class MockCodexAdapter implements CodexAdapter {
  async analyze(request: InvestigationRequest): Promise<ReproductionHypothesis> {
    void request;
    return mockHypothesis;
  }

  async generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
    void input;
    return mockGeneratedTest;
  }
}

const defaultExecutionResult: ExecutionResult = {
  command: "npx playwright test tests/failspec.mock.spec.ts",
  exitCode: 0,
  timedOut: false,
  stdout: "Mock runner completed.",
  stderr: "",
  durationMs: 1,
  artifacts: []
};

export class MockRunnerAdapter implements RunnerAdapter {
  constructor(private readonly result: ExecutionResult = defaultExecutionResult) {}

  async run(input: RunnerInput): Promise<ExecutionResult> {
    void input;
    return this.result;
  }
}
