import express, { type ErrorRequestHandler } from "express";

export function createApp() {
  const app = express();

  app.use(express.json());

  app.get("/api/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    void next;
    console.error(error);
    response.status(500).json({ error: "Internal server error" });
  };

  app.use(errorHandler);
  return app;
}
