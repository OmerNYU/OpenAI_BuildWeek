import { describe, expect, it } from "vitest";
import { buildAnalysisPrompt, buildTestGenerationPrompt } from "../src/codex/prompt.js";

const request = {
  repositoryPath: "/tmp/checkout-app",
  bugTitle: "Checkout validation is missing",
  bugDescription: "Submitting an empty checkout form does not show an error.",
  expectedBehavior: "A required-field message appears.",
  actualBehavior: "The page does not show validation feedback.",
  terminalLog: "Browser console is clean."
};

const hypothesis = {
  summary: "Checkout does not show the validation error.",
  confidence: "high" as const,
  relevantFiles: [
    { path: "src/checkout.tsx", reason: "It renders the checkout form." }
  ],
  reproductionSteps: ["Open checkout.", "Submit an empty form."],
  expectedFailureSignal: "The required-field message is missing.",
  assumptions: ["The local app starts successfully."]
};

describe("Codex prompts", () => {
  it("sets the bounded analysis rules and preflight-derived repository context", () => {
    const prompt = buildAnalysisPrompt(request);

    expect(prompt).toContain("Inspect repository files in read-only mode.");
    expect(prompt).toContain("preflighted isolated worktree");
    expect(prompt).toContain("Playwright config, test directory, start command, base URL");
    expect(prompt).toContain("existing Playwright test examples");
    expect(prompt).toContain("Checkout validation is missing");
    expect(prompt).toContain("Browser console is clean.");
    expect(prompt).toContain('"evidence"');
  });

  it("requests exactly one regression test from a ready hypothesis", () => {
    const prompt = buildTestGenerationPrompt(request, hypothesis);

    expect(prompt).toContain("Generate exactly one minimal Playwright regression test.");
    expect(prompt).toContain("Checkout does not show the validation error.");
    expect(prompt).toContain('"generatedTestContent"');
  });

  it("states the approved generated-test grammar", () => {
    const prompt = buildTestGenerationPrompt(request, hypothesis);

    expect(prompt).toContain("Import exactly { expect, test } from '@playwright/test'.");
    expect(prompt).toContain("Every interaction and assertion must be awaited.");
    expect(prompt).toContain("Allowed locator text assertions include toContainText");
    expect(prompt).toContain("page.goto");
    expect(prompt).toContain("expect(...).toContainText");
    expect(prompt).toContain("Reuse selectors, routes, and behavioral expectations from the repository only when they are compatible with this policy.");
    expect(prompt).toContain("This policy overrides incompatible repository helpers, custom fixtures, variables, aliases, page objects, and conventions.");
    expect(prompt).toContain("Include at least one approved interaction and at least one assertion.");
  });
});
