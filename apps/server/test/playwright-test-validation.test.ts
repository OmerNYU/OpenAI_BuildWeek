import { describe, expect, it } from "vitest";
import { validateGeneratedPlaywrightTest } from "../src/codex/playwright-test.js";

const validTest =
  "import { expect, test } from '@playwright/test';\n\ntest('shows validation', async ({ page }) => {\n  await page.goto('/checkout');\n  await expect(page.getByText('Required')).toBeVisible();\n});\n";

describe("validateGeneratedPlaywrightTest", () => {
  it("accepts one syntactically valid Playwright test", () => {
    expect(validateGeneratedPlaywrightTest(validTest)).toEqual({ valid: true, errors: [] });
  });

  it("rejects multiple actual Playwright test calls", () => {
    const content = `${validTest}\ntest('another test', async ({ page }) => {\n  await page.goto('/other');\n  await expect(page).toBeTruthy();\n});\n`;

    expect(validateGeneratedPlaywrightTest(content)).toEqual({
      valid: false,
      errors: ["Generated test must declare exactly one Playwright test"]
    });
  });

  it("rejects invalid TypeScript", () => {
    const content =
      "import { expect, test } from '@playwright/test';\n\ntest('broken', async ({ page }) => {\n  await page.goto('/checkout');\n";

    expect(validateGeneratedPlaywrightTest(content)).toEqual({
      valid: false,
      errors: ["Generated test must be valid TypeScript"]
    });
  });

  it("rejects comments that only resemble a Playwright test", () => {
    const content =
      "// import { expect, test } from '@playwright/test';\n// test('fake');\n// page.goto('/checkout');\n// expect(true);\n";

    expect(validateGeneratedPlaywrightTest(content)).toEqual({
      valid: false,
      errors: [
        "Generated test must import test from @playwright/test",
        "Generated test must declare exactly one Playwright test",
        "Generated test must include a user interaction",
        "Generated test must include an assertion"
      ]
    });
  });

  it("rejects a local parameter that shadows the Playwright test import", () => {
    const content =
      "import { expect, test } from '@playwright/test';\n\nfunction helper(test: () => void) {\n  test();\n}\n\nconst page = { goto() {} };\npage.goto();\nexpect(true);\n";

    expect(validateGeneratedPlaywrightTest(content)).toEqual({
      valid: false,
      errors: ["Generated test must not shadow the Playwright test import"]
    });
  });
});
