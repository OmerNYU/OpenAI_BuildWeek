import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { investigationSchema, type Investigation } from "@failspec/contracts";
import type { InvestigationStore } from "./investigation-store.js";

const investigationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[4-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class JsonInvestigationStore implements InvestigationStore {
  constructor(private readonly directory: string) {}

  async save(investigation: Investigation): Promise<void> {
    const validatedInvestigation = investigationSchema.parse(investigation);
    if (!isValidInvestigationId(validatedInvestigation.id)) {
      throw new Error("Invalid investigation ID.");
    }

    await mkdir(this.directory, { recursive: true });
    const destination = this.pathFor(validatedInvestigation.id);
    const temporary = `${destination}.${randomUUID()}.tmp`;

    try {
      await writeFile(temporary, JSON.stringify(validatedInvestigation, null, 2), "utf8");
      await rename(temporary, destination);
    } catch (error) {
      try {
        await unlink(temporary);
      } catch {
        // Preserve the original storage error when cleanup is not possible.
      }
      throw error;
    }
  }

  async getById(id: string): Promise<Investigation | undefined> {
    if (!isValidInvestigationId(id)) {
      return undefined;
    }

    try {
      const contents = await readFile(this.pathFor(id), "utf8");
      return investigationSchema.parse(JSON.parse(contents));
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  }

  private pathFor(id: string): string {
    return join(this.directory, `${id}.json`);
  }
}

function isValidInvestigationId(id: string): boolean {
  return investigationIdPattern.test(id);
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
