import type {
  CodexAnalysisResult,
  ExecutionResult,
  InvestigationRequest,
  ReproductionHypothesis,
  RunnerOutput
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
  async analyze(request: InvestigationRequest): Promise<CodexAnalysisResult> {
    void request;
    return { hypothesis: mockHypothesis, evidence: [] };
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

const defaultRunnerOutput: RunnerOutput = {
  execution: defaultExecutionResult,
  evidence: {
    testTitle: "Mock regression test",
    testStatus: "passed",
    consoleErrors: [],
    pageErrors: [],
    artifactPaths: defaultExecutionResult.artifacts
  }
};

export class MockRunnerAdapter implements RunnerAdapter {
  private readonly result: RunnerOutput;

  constructor(result: RunnerOutput | ExecutionResult = defaultRunnerOutput) {
    this.result = "execution" in result
      ? result
      : {
          execution: result,
          evidence: {
            testStatus: "unknown",
            consoleErrors: [],
            pageErrors: [],
            artifactPaths: result.artifacts
          }
        };
  }

  async run(input: RunnerInput): Promise<RunnerOutput> {
    void input;
    return this.result;
  }
}
