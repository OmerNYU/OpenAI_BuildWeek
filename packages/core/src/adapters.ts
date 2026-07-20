import type {
  CodexAnalysisResult,
  InvestigationRequest,
  ReproductionHypothesis,
  RunnerOutput
} from "@failspec/contracts";

export interface GeneratedTest {
  content: string;
  path?: string;
}

export interface GenerateTestInput {
  request: InvestigationRequest;
  hypothesis: ReproductionHypothesis;
}

export interface CodexAdapter {
  analyze(request: InvestigationRequest): Promise<CodexAnalysisResult>;

  generateTest(input: GenerateTestInput): Promise<GeneratedTest>;
}

export interface RunnerInput {
  repositoryPath: string;
  generatedTest: GeneratedTest;
  signal?: AbortSignal;
}

export interface RunnerAdapter {
  run(input: RunnerInput): Promise<RunnerOutput>;
}
