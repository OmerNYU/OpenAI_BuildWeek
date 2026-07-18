import express, { type ErrorRequestHandler } from "express";
import type { CodexAdapter, RunnerAdapter } from "@failspec/core";
import { createInvestigationsRouter } from "./routes/investigations.js";
import { InvestigationService } from "./services/investigation-service.js";
import type { InvestigationStore } from "./storage/investigation-store.js";

export interface AppDependencies {
  store: InvestigationStore;
  codexAdapter: CodexAdapter;
  runnerAdapter: RunnerAdapter;
}

export function createApp(dependencies: AppDependencies) {
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
