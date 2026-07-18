import { describe, expect, it } from "vitest";
import { failureMessageFor } from "../src/failure-messages.js";

describe("failureMessageFor", () => {
  it("returns fixed safe messages for typed failures", () => {
    expect(failureMessageFor("dirty_repository")).toBe("Repository has uncommitted changes.");
    expect(failureMessageFor("creation_failed")).toBe("Worktree could not be prepared.");
    expect(failureMessageFor("disallowed_import")).toBe("Generated test uses an unsupported import.");
  });
});
