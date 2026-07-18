import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createRuntimeDependencies } from "../src/runtime-dependencies.js";

describe("GET /api/health", () => {
  it("returns a deterministic health response", async () => {
    const investigationDirectory = await mkdtemp(join(tmpdir(), "failspec-health-"));

    try {
      const response = await request(
        createApp(
          createRuntimeDependencies({
            env: { FAILSPEC_CODEX_MODE: "mock" },
            investigationDirectory
          })
        )
      ).get("/api/health");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "ok" });
    } finally {
      await rm(investigationDirectory, { recursive: true, force: true });
    }
  });
});
