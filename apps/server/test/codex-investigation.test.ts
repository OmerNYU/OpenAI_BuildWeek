import { describe, expect, it } from "vitest";
import { CodexJsonlClient } from "../src/codex/client.js";
import { runCodexInvestigation } from "../src/codex/investigation.js";

const request = {
  repositoryPath: "/tmp/checkout-app",
  bugTitle: "Checkout validation is missing",
  bugDescription: "Submitting an empty checkout form does not show an error.",
  expectedBehavior: "A required-field message appears.",
  actualBehavior: "The page does not show validation feedback."
};

const output = {
  hypothesis: {
    summary: "Checkout does not show the validation error.",
    confidence: "high" as const,
    relevantFiles: [
      { path: "src/checkout.tsx", reason: "It renders the checkout form." }
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
    "import { expect, test } from '@playwright/test';\n\ntest('shows checkout validation', async ({ page }) => {\n  await page.goto('/checkout');\n  await expect(page.getByText('Required')).toBeVisible();\n});\n"
};

function jsonlMessage(value: unknown): string {
  return `${JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(value) }
  })}\n`;
}

describe("runCodexInvestigation", () => {
  it("returns validated output from the first Codex response", async () => {
    const calls: Array<{ cwd: string; prompt: string }> = [];
    const client = new CodexJsonlClient({
      async execute(input) {
        calls.push(input);
        return { exitCode: 0, stdout: jsonlMessage(output), stderr: "" };
      }
    });

    await expect(runCodexInvestigation(client, request)).resolves.toEqual(output);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cwd: request.repositoryPath });
  });

  it("retries once when the first response is not a valid Playwright test", async () => {
    const calls: Array<{ cwd: string; prompt: string }> = [];
    const client = new CodexJsonlClient({
      async execute(input) {
        calls.push(input);
        const response = calls.length === 1
          ? { ...output, generatedTestContent: "console.log('not a test');" }
          : output;

        return { exitCode: 0, stdout: jsonlMessage(response), stderr: "" };
      }
    });

    await expect(runCodexInvestigation(client, request)).resolves.toEqual(output);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.prompt).toContain("Your previous response was invalid");
  });

  it("does not retry a failed Codex CLI command", async () => {
    let calls = 0;
    const client = new CodexJsonlClient({
      async execute() {
        calls += 1;
        return { exitCode: 1, stdout: "", stderr: "Authentication failed" };
      }
    });

    await expect(runCodexInvestigation(client, request)).rejects.toThrow("Authentication failed");
    expect(calls).toBe(1);
  });
});
