import express, { type ErrorRequestHandler } from "express";
import { MockCodexAdapter, MockRunnerAdapter, type CodexAdapter, type RunnerAdapter } from "@failspec/core";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createInvestigationsRouter } from "./routes/investigations.js";
import { InvestigationService } from "./services/investigation-service.js";
import { JsonInvestigationStore } from "./storage/json-investigation-store.js";
import type { InvestigationStore } from "./storage/investigation-store.js";

export interface AppDependencies {
  store: InvestigationStore;
  codexAdapter: CodexAdapter;
  runnerAdapter: RunnerAdapter;
}

function createDefaultDependencies(): AppDependencies {
  const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

  return {
    store: new JsonInvestigationStore(join(repositoryRoot, ".failspec", "investigations")),
    codexAdapter: new MockCodexAdapter(),
    runnerAdapter: new MockRunnerAdapter()
  };
}

export function createApp(dependencies: AppDependencies = createDefaultDependencies()) {
  const app = express();
  const investigationService = new InvestigationService(
    dependencies.store,
    dependencies.codexAdapter,
    dependencies.runnerAdapter
  );

  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.use(createInvestigationsRouter(investigationService));

  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    void next;
    console.error(error);
    response.status(500).json({ error: "Internal server error" });
  };

  app.use(errorHandler);
  return app;
}
