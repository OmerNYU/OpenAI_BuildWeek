import { describe, expect, it } from "vitest";
import { buildInvestigationPrompt } from "../src/codex/prompt.js";

describe("buildInvestigationPrompt", () => {
  it("sets the bounded investigation rules and includes the bug report", () => {
    const prompt = buildInvestigationPrompt({
      repositoryPath: "/tmp/checkout-app",
      bugTitle: "Checkout validation is missing",
      bugDescription: "Submitting an empty checkout form does not show an error.",
      expectedBehavior: "A required-field message appears.",
      actualBehavior: "The page does not show validation feedback.",
      terminalLog: "Browser console is clean."
    });

    expect(prompt).toContain("Inspect repository files in read-only mode.");
    expect(prompt).toContain("Do not modify production code.");
    expect(prompt).toContain("Generate exactly one minimal Playwright regression test.");
    expect(prompt).toContain("Checkout validation is missing");
    expect(prompt).toContain("Browser console is clean.");
    expect(prompt).toContain('"generatedTestContent"');
  });
});
