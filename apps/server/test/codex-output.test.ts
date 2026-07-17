import { describe, expect, it } from "vitest";
import { parseCodexInvestigationOutput } from "../src/codex/output.js";

const validOutput = {
  hypothesis: {
    summary: "Checkout does not show the validation error.",
    confidence: "high",
    relevantFiles: [
      {
        path: "src/checkout.tsx",
        reason: "It renders the checkout form."
      }
    ],
    reproductionSteps: ["Open checkout.", "Submit an empty form."],
    expectedFailureSignal: "The required-field message is missing.",
    assumptions: ["The local app starts successfully."]
  },
  evidence: [
    {
      sourcePath: "src/checkout.tsx",
      observation: "The submit handler does not render an error message."
    }
  ],
  generatedTestContent:
    "import { expect, test } from '@playwright/test';\n\ntest('shows checkout validation', async ({ page }) => {\n  await page.goto('/checkout');\n  await page.getByRole('button', { name: 'Submit' }).click();\n  await expect(page.getByText('Required')).toBeVisible();\n});\n"
};

describe("parseCodexInvestigationOutput", () => {
  it("returns validated hypothesis, evidence, and generated test content", () => {
    expect(parseCodexInvestigationOutput(validOutput)).toEqual(validOutput);
  });

  it("rejects evidence that does not reference a relevant file", () => {
    expect(() =>
      parseCodexInvestigationOutput({
        ...validOutput,
        evidence: [{ sourcePath: "src/unrelated.ts", observation: "Unrelated." }]
      })
    ).toThrow("Evidence source path must be a relevant file");
  });
});
