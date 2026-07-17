import { describe, expect, it } from "vitest";
import { validateGeneratedPlaywrightTest } from "../src/codex/playwright-test.js";

describe("validateGeneratedPlaywrightTest", () => {
  it("accepts a minimal Playwright test with an interaction and assertion", () => {
    const result = validateGeneratedPlaywrightTest(
      "import { expect, test } from '@playwright/test';\n\ntest('shows validation', async ({ page }) => {\n  await page.goto('/checkout');\n  await page.getByRole('button', { name: 'Submit' }).click();\n  await expect(page.getByText('Required')).toBeVisible();\n});\n"
    );

    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("rejects content without the required Playwright test structure", () => {
    const result = validateGeneratedPlaywrightTest("console.log('not a test');");

    expect(result).toEqual({
      valid: false,
      errors: [
        "Generated test must import @playwright/test",
        "Generated test must declare a Playwright test",
        "Generated test must include a user interaction",
        "Generated test must include an assertion"
      ]
    });
  });
});
