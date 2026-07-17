import { describe, expect, it } from "vitest";
import { investigationRequestSchema } from "../src/investigation.js";

describe("investigationRequestSchema", () => {
  it("rejects required whitespace-only fields", () => {
    expect(
      investigationRequestSchema.safeParse({
        repositoryPath: "  ",
        bugTitle: "Title",
        bugDescription: "Description",
        expectedBehavior: "Expected",
        actualBehavior: "Actual"
      }).success
    ).toBe(false);
  });
});
