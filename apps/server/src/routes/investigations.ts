import { Router } from "express";
import { investigationRequestSchema } from "@failspec/contracts";
import type { InvestigationService } from "../services/investigation-service.js";

export function createInvestigationsRouter(service: InvestigationService) {
  const router = Router();

  router.post("/api/investigations", async (request, response, next) => {
    const parsed = investigationRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({
        error: "Invalid investigation request.",
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message
        }))
      });
      return;
    }

    try {
      const investigation = await service.create(parsed.data);
      response.status(201).json(investigation);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/investigations/:id", async (request, response, next) => {
    try {
      const investigation = await service.getById(request.params.id);
      if (!investigation) {
        response.status(404).json({ error: "Investigation not found." });
        return;
      }
      response.json(investigation);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
