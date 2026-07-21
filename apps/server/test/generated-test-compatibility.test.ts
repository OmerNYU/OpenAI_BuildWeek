import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateGeneratedPlaywrightTest } from "../src/codex/playwright-test.js";
import { validateGeneratedTestSource } from "../src/generated-test/index.js";
import { stageGeneratedTest } from "../src/runner/staging.js";

const directories: string[] = [];
const cases = [
  {
    name: "a local toContainText regression test",
    content: program("await page.goto('/checkout'); await page.getByText('Required').click(); await expect(page.getByText('Required')).toContainText('Required');"),
    valid: true
  },
  {
    name: "a role locator with literal options",
    content: program("await page.goto('/'); await page.getByRole('button', { name: 'Complete checkout' }).click(); await expect(page.getByRole('status')).toHaveText('Charged total: $24.00');"),
    valid: true
  },
  {
    name: "a local request target",
    content: program("await request.get('http://127.0.0.1:3100/api'); await page.click('button'); await expect(true).toBe(true);", "{ page, request }"),
    valid: true
  },
  {
    name: "an aliased Playwright import",
    content: "import { expect, test as pwTest } from '@playwright/test'; pwTest('x', async ({ page }) => { await page.click('button'); await expect(true).toBe(true); });",
    valid: false
  },
  {
    name: "a type-only Playwright import",
    content: "import { expect, type test } from '@playwright/test'; test('x', async ({ page }) => { await page.click('button'); await expect(true).toBe(true); });",
    valid: false
  },
  {
    name: "a Playwright import with attributes",
    content: "import { expect, test } from '@playwright/test' with { type: 'json' }; test('x', async ({ page }) => { await page.click('button'); await expect(true).toBe(true); });",
    valid: true
  },
  {
    name: "a rest fixture binding",
    content: program("await page.click('button'); await expect(true).toBe(true);", "{ ...page }"),
    valid: true
  },
  {
    name: "duplicate fixture bindings",
    content: program("await page.click('button'); await expect(true).toBe(true);", "{ page, page }"),
    valid: true
  },
  {
    name: "an un-awaited assertion",
    content: program("await page.click('button'); expect(true).toBe(true);"),
    valid: false
  },
  {
    name: "an unrestricted test-body statement",
    content: program("const value = 'button'; await page.click(value); await expect(true).toBe(true);"),
    valid: false
  },
  {
    name: "an external navigation target",
    content: program("await page.goto('https://example.com'); await page.click('button'); await expect(true).toBe(true);"),
    valid: false
  }
] as const;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generated-test policy compatibility", () => {
  it.each(cases)("keeps Codex and staging aligned for $name", async ({ content, valid }) => {
    expect(validateGeneratedTestSource(content).valid).toBe(valid);
    expect(validateGeneratedPlaywrightTest(content).valid).toBe(valid);

    const worktree = await createWorktree();
    if (valid) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({ status: "staged" });
      return;
    }
    await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({ status: "rejected" });
  });
});

function program(body: string, fixtures = "{ page }"): string {
  return `import { expect, test } from '@playwright/test';\ntest('x', async (${fixtures}) => { ${body} });`;
}

async function createWorktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "failspec-generated-test-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  return directory;
}
