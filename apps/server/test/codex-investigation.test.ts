import type { CodexAdapter } from "@failspec/core";
import { describe, expect, it } from "vitest";
import { CodexInvestigationAdapter } from "../src/codex/adapter.js";
import { CodexJsonlClient } from "../src/codex/client.js";

const request = {
  repositoryPath: "/tmp/checkout-app",
  bugTitle: "Checkout validation is missing",
  bugDescription: "Submitting an empty checkout form does not show an error.",
  expectedBehavior: "A required-field message appears.",
  actualBehavior: "The page does not show validation feedback."
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

const analysis = {
  hypothesis,
  evidence: [
    {
      sourcePath: "src/checkout.tsx",
      observation: "The submit handler does not render an error message."
    }
  ]
};

const generatedTestContent =
  "import { expect, test } from '@playwright/test';\n\ntest('shows checkout validation', async ({ page }) => {\n  await page.goto('/checkout');\n  await expect(page.getByText('Required')).toBeVisible();\n});\n";

function jsonlMessage(value: unknown): string {
  return `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(value) }
  })}\n`;
}

describe("CodexInvestigationAdapter", () => {
  it("implements separate analyze and generateTest operations", async () => {
    const calls: Array<{ cwd: string; prompt: string }> = [];
    const responses = [analysis, { generatedTestContent }];
    const client = new CodexJsonlClient({
      async execute(input) {
        calls.push(input);
        return { exitCode: 0, stdout: jsonlMessage(responses.shift()), stderr: "" };
      }
    });
    const adapter: CodexAdapter = new CodexInvestigationAdapter(client);

    await expect(adapter.analyze(request)).resolves.toEqual(hypothesis);
    await expect(adapter.generateTest({ request, hypothesis })).resolves.toEqual({
      content: generatedTestContent
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ cwd: request.repositoryPath });
    expect(calls[0]?.prompt).toContain("preflighted isolated worktree");
    expect(calls[1]?.prompt).toContain("Generate exactly one minimal Playwright regression test.");
  });

  it("retries generated test output once when it fails structural validation", async () => {
    const calls: Array<{ cwd: string; prompt: string }> = [];
    const responses = [
      analysis,
      { generatedTestContent: "console.log('not a test');" },
      { generatedTestContent }
    ];
    const client = new CodexJsonlClient({
      async execute(input) {
        calls.push(input);
        return { exitCode: 0, stdout: jsonlMessage(responses.shift()), stderr: "" };
      }
    });
    const adapter = new CodexInvestigationAdapter(client);

    const foundHypothesis = await adapter.analyze(request);

    await expect(adapter.generateTest({ request, hypothesis: foundHypothesis })).resolves.toEqual({
      content: generatedTestContent
    });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.prompt).toContain("Your previous response was invalid");
  });
});
