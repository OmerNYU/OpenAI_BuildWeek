import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Investigation } from "@failspec/contracts";
import { JsonInvestigationStore } from "../src/storage/json-investigation-store.js";

let storageDirectory: string;

beforeEach(async () => {
  storageDirectory = await mkdtemp(join(tmpdir(), "failspec-json-store-"));
});

afterEach(async () => {
  await rm(storageDirectory, { recursive: true, force: true });
});

describe("JsonInvestigationStore", () => {
  it("saves and reloads a valid UUID investigation", async () => {
    const store = new JsonInvestigationStore(storageDirectory);
    const investigation = validInvestigation();

    await store.save(investigation);

    await expect(access(join(storageDirectory, `${investigation.id}.json`))).resolves.toBeUndefined();
    await expect(store.getById(investigation.id)).resolves.toEqual(investigation);
  });

  it("rejects unsafe IDs before creating an investigation file", async () => {
    const store = new JsonInvestigationStore(storageDirectory);
    const investigation = { ...validInvestigation(), id: "../outside" } as Investigation;

    await expect(store.save(investigation)).rejects.toThrow("Invalid investigation ID.");
    await expect(access(join(storageDirectory, "..", "outside.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects malformed runtime data before persistence", async () => {
    const store = new JsonInvestigationStore(storageDirectory);
    const investigation = { ...validInvestigation(), status: "not-a-status" } as unknown as Investigation;

    await expect(store.save(investigation)).rejects.toBeDefined();
    await expect(access(join(storageDirectory, `${investigation.id}.json`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns undefined for unsafe lookup IDs", async () => {
    const store = new JsonInvestigationStore(storageDirectory);

    await expect(store.getById("../outside")).resolves.toBeUndefined();
  });
});

function validInvestigation(): Investigation {
  const now = "2026-07-17T00:00:00.000Z";
  return {
    id: "0f3dbf27-7ee6-4d17-bcbc-b0f64e9c46b1",
    request: {
      repositoryPath: "C:/repos/example",
      bugTitle: "Example failure",
      bugDescription: "Example description.",
      expectedBehavior: "Expected behavior.",
      actualBehavior: "Actual behavior."
    },
    status: "created",
    executionEvidence: {
      testTitle: "Example test",
      testStatus: "failed",
      assertionFailureMessage: "Expected completion.",
      consoleErrors: ["Checkout error."],
      pageErrors: [],
      artifactPaths: ["artifacts/example-trace.zip"]
    },
    timeline: [{ status: "created", at: now, message: "Investigation created." }],
    createdAt: now,
    updatedAt: now
  };
}
