import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MockCodexAdapter, MockRunnerAdapter, type CodexAdapter } from "@failspec/core";
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
import { JsonInvestigationStore } from "./storage/json-investigation-store.js";

export type CodexMode = "mock" | "local";

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
    store: new JsonInvestigationStore(
      options.investigationDirectory ?? defaultInvestigationDirectory()
    ),
    codexAdapter,
    runnerAdapter: new MockRunnerAdapter(),
    scheduler: new InProcessWorkflowScheduler(),
    repositoryWorkspace: options.repositoryWorkspace ?? createRepositoryWorkspace(mode)
  };
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
