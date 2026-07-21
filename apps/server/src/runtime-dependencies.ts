import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  classifyVerification,
  MockCodexAdapter,
  MockRunnerAdapter,
  type CodexAdapter,
  type RunnerAdapter
} from "@failspec/core";
import type { AppDependencies } from "./app.js";
import { CodexInvestigationAdapter } from "./codex/adapter.js";
import { CodexJsonlClient, type CodexCliExecutor } from "./codex/client.js";
import { createLocalCodexCliExecutor } from "./codex/executor.js";
import { InProcessWorkflowScheduler } from "./scheduling/workflow-scheduler.js";
import {
  LocalRepositoryWorkspace,
  PassThroughRepositoryWorkspace,
  type RepositoryWorkspace
} from "./repository/repository-workspace.js";
import { PlaywrightRunnerAdapter } from "./runner/playwright-runner.js";
import { stageGeneratedTest } from "./runner/staging.js";
import type {
  GeneratedTestStager,
  InvestigationRuntimeMode,
  VerificationClassifier
} from "./services/investigation-service.js";
import { JsonInvestigationStore } from "./storage/json-investigation-store.js";

export type CodexMode = InvestigationRuntimeMode;

export interface RuntimeDependencyOptions {
  env?: NodeJS.ProcessEnv;
  codexCliExecutor?: CodexCliExecutor;
  investigationDirectory?: string;
  repositoryWorkspace?: RepositoryWorkspace;
}

export function createRuntimeDependencies(
  options: RuntimeDependencyOptions = {}
): AppDependencies {
  const mode = parseCodexMode(options.env?.FAILSPEC_CODEX_MODE);
  const codexAdapter = createCodexAdapter(mode, options.codexCliExecutor);

  return {
    mode,
    store: new JsonInvestigationStore(
      options.investigationDirectory ?? defaultInvestigationDirectory()
    ),
    codexAdapter,
    runnerAdapter: createRunnerAdapter(mode),
    generatedTestStager: createGeneratedTestStager(mode),
    verificationClassifier: createVerificationClassifier(mode),
    scheduler: new InProcessWorkflowScheduler(),
    repositoryWorkspace: options.repositoryWorkspace ?? createRepositoryWorkspace(mode)
  };
}

function createVerificationClassifier(mode: CodexMode): VerificationClassifier {
  return mode === "local" ? classifyVerification : mockVerificationClassifier;
}

const mockVerificationClassifier: VerificationClassifier = () => ({
  verdict: "verified",
  explanation: "The deterministic mock runner returned the expected reproduction signal.",
  recommendedNextStep: "Review the generated regression test before running it against a real repository.",
  supportingSignals: [
    { type: "mock_verification", message: "Deterministic mock verification completed." }
  ]
});

function createRunnerAdapter(mode: CodexMode): RunnerAdapter {
  return mode === "local" ? new PlaywrightRunnerAdapter() : new MockRunnerAdapter();
}

function createGeneratedTestStager(mode: CodexMode): GeneratedTestStager {
  return mode === "local" ? stageGeneratedTest : stageMockGeneratedTest;
}

async function stageMockGeneratedTest(
  worktreePath: string,
  content: string
) {
  void worktreePath;
  void content;
  return { status: "staged" as const, stagedTestPath: "tests/failspec.mock.spec.ts" };
}

function createRepositoryWorkspace(mode: CodexMode): RepositoryWorkspace {
  return mode === "local"
    ? new LocalRepositoryWorkspace()
    : new PassThroughRepositoryWorkspace();
}

export function parseCodexMode(value: string | undefined): CodexMode {
  if (value === undefined || value === "mock") {
    return "mock";
  }
  if (value === "local") {
    return "local";
  }

  throw new Error("Unsupported FAILSPEC_CODEX_MODE; expected \"mock\" or \"local\".");
}

function createCodexAdapter(
  mode: CodexMode,
  executor: CodexCliExecutor | undefined
): CodexAdapter {
  if (mode === "mock") {
    return new MockCodexAdapter();
  }

  return new CodexInvestigationAdapter(
    new CodexJsonlClient(executor ?? createLocalCodexCliExecutor())
  );
}

function defaultInvestigationDirectory(): string {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
  return join(repositoryRoot, ".failspec", "investigations");
}
