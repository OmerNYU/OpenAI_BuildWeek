import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateGeneratedPlaywrightTest } from "../src/codex/playwright-test.js";
import { generatedTestCapabilities, stageGeneratedTest, stagedGeneratedTestPath } from "../src/runner/staging.js";

const directories: string[] = [];
const validTest = "import { expect, test } from '@playwright/test';\ntest('checkout', async ({ page }) => { await page.goto('/'); await page.click('button'); await expect(true).toBe(true); });";
const compatibleTest = "import { expect, test } from '@playwright/test';\ntest('checkout', async ({ page }) => { await page.goto('/'); await page.getByText('Required').click(); await expect(page.getByText('Required')).toContainText('Required'); });";

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generated-test staging", () => {
  it("stages one valid test at the fixed worktree path", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, validTest)).resolves.toEqual({
      status: "staged", stagedTestPath: stagedGeneratedTestPath
    });
    await expect(readFile(join(worktree, stagedGeneratedTestPath), "utf8")).resolves.toBe(validTest);
  });

  it("stages the same unaliased generated-test surface accepted by Codex validation", async () => {
    const worktree = await createWorktree();
    expect(validateGeneratedPlaywrightTest(compatibleTest)).toEqual({ valid: true, errors: [] });
    await expect(stageGeneratedTest(worktree, compatibleTest)).resolves.toMatchObject({ status: "staged" });
  });

  it("accepts every capability from the single generated-test policy table", async () => {
    for (const capability of generatedTestCapabilities) {
      const worktree = await createWorktree();
      await expect(stageGeneratedTest(worktree, generatedTest(capabilityStatement(capability)))).resolves.toMatchObject({ status: "staged" });
    }
  });

  it("rejects invalid forms derived from every generated-test capability", async () => {
    for (const capability of generatedTestCapabilities) {
      for (const statement of invalidCapabilityStatements(capability)) {
        const worktree = await createWorktree();
        await expect(stageGeneratedTest(worktree, generatedTest(`${statement}; await page.click('button'); await expect(true).toBe(true);`))).resolves.toMatchObject({
          status: "rejected", failure: { code: "disallowed_api" }
        });
      }
    }
  });

  it("accepts a test at the exact 256 KiB boundary", async () => {
    const worktree = await createWorktree();
    const content = validTest + "\n//" + "x".repeat(256 * 1024 - Buffer.byteLength(validTest, "utf8") - 3);
    expect(Buffer.byteLength(content, "utf8")).toBe(256 * 1024);
    await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({ status: "staged" });
  });

  it("rejects invalid UTF-8", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "const value = '\ud800';")).resolves.toMatchObject({
      status: "rejected", failure: { code: "invalid_encoding" }
    });
  });

  it("rejects content larger than 256 KiB", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "x".repeat(256 * 1024 + 1))).resolves.toMatchObject({
      status: "rejected", failure: { code: "file_too_large" }
    });
  });

  it("rejects TypeScript syntax errors", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "test('broken', () => {")).resolves.toMatchObject({
      status: "rejected", failure: { code: "typescript_parse_failed" }
    });
  });

  it("rejects imports outside @playwright/test", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "import { readFile } from 'fs';")).resolves.toMatchObject({
      status: "rejected", failure: { code: "disallowed_import" }
    });
  });

  it("allows only test and expect imports from @playwright/test", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "import { chromium } from '@playwright/test';",
      "import defaultBinding, { expect, test } from '@playwright/test';"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_import" }
      });
    }
  });

  it("rejects dynamic imports of forbidden Node modules", async () => {
    const worktree = await createWorktree();
    for (const module of ["node:child_process", "node:fs", "node:net", "node:worker_threads"]) {
      await expect(stageGeneratedTest(worktree, `await import('${module}');`)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects forbidden module names in string literals", async () => {
    const worktree = await createWorktree();
    for (const module of ["child_process", "node:child_process", "fs", "node:fs", "net", "node:net", "dgram", "node:dgram", "worker_threads", "node:worker_threads"]) {
      await expect(stageGeneratedTest(worktree, `const moduleName = '${module}';`)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects Node built-in module loading", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "process.getBuiltinModule('child_process')?.execSync('echo unsafe');")).resolves.toMatchObject({
      status: "rejected", failure: { code: "disallowed_api" }
    });
  });

  it("rejects property and computed CommonJS loading", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "module.require('./helper');",
      "module['require']('./helper');",
      "module[`require`]('./helper');",
      "module[`req${\"uire\"}`]('./helper');"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects all Node module-root usage", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "module.constructor._load('path');")).resolves.toMatchObject({
      status: "rejected", failure: { code: "disallowed_api" }
    });
  });

  it("rejects Node process-root usage", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "process.binding('f' + 's');")).resolves.toMatchObject({
      status: "rejected", failure: { code: "disallowed_api" }
    });
  });

  it("rejects forbidden APIs", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "eval('1');")).resolves.toMatchObject({
      status: "rejected", failure: { code: "disallowed_api" }
    });
  });

  it("rejects indirect global eval access", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "globalThis['eval']('1');",
      "globalThis[`eval`]('1');",
      "globalThis[eval]('1');",
      "globalThis[`ev${\"al\"}`]('1');"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects indirect global Function access", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "globalThis['Function']('return 1')();",
      "globalThis[`Function`]('return 1')();",
      "globalThis[`Fun${\"ction\"}`]('return 1')();"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects constructor-based dynamic code access", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "({}).constructor.constructor('return process')();",
      "({})['con' + 'structor']['con' + 'structor']('return process')();",
      "const key = 'constructor'; ({})[key]();"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects obvious external network use", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "fetch('https://example.com');")).resolves.toMatchObject({
      status: "rejected", failure: { code: "disallowed_api" }
    });
  });

  it("rejects computed global network APIs", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "globalThis['fetch']('https://' + 'example.com');",
      "global['fetch']('https://' + 'example.com');"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects aliases of global capability roots", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "const root = globalThis; root['fe' + 'tch']('https://' + 'example.com');")).resolves.toMatchObject({
      status: "rejected", failure: { code: "disallowed_api" }
    });
  });

  it("allows only local static Playwright navigation and request targets", async () => {
    for (const content of ["page.goto('/checkout');", "page.goto('http://127.0.0.1:3100/');", "request.get('https://localhost/api');", "request.fetch('/api');"]) {
      const worktree = await createWorktree();
      await expect(stageGeneratedTest(worktree, generatedTest(`await ${content.replace(/;$/, "")}; await page.click('button'); await expect(true).toBe(true);`))).resolves.toMatchObject({ status: "staged" });
    }
  });

  it("rejects external or dynamic Playwright navigation and request targets", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "page.goto('https://' + 'example.com');",
      "page.goto(target);",
      "request.get(`https://example.com`);",
      "page.request.post('/api/' + endpoint);",
      "page.goto('//example.com');",
      "request.get('//example.com');",
      "page.goto('/\\\\example.com');"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects computed Playwright navigation and request methods", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "page['goto']('https://' + 'example.com');",
      "request[`get`]('https://' + 'example.com');",
      "page[method]('/checkout');",
      "request[method]('/api')"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects escaped Playwright navigation and request methods", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "page.goto.call(page, 'https://' + 'example.com');",
      "page.goto.bind(page)('/checkout');",
      "Reflect.apply(page.goto, page, ['/checkout']);",
      "const navigate = page.goto; navigate('/checkout');",
      "request.get.call(request, '/api');"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects aliased, destructured, and chained Playwright navigation and request methods", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "const p = page; p.goto('https://' + 'example.com');",
      "const r = request; r.get('https://' + 'example.com');",
      "const { goto } = page; goto('/checkout');",
      "const { get } = request; get('/api');",
      "page.context().newPage().goto('https://' + 'example.com');"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects dynamic-code and resource-loading Playwright APIs", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "page.evaluate(\"fetch('https://example.com')\");",
      "page.evaluate.call(page, \"fetch('https://example.com')\");",
      "page.setContent(\"<script src='https://example.com/x.js'></script>\");",
      "page.addScriptTag({ url: 'https://' + 'example.com/x.js' });"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects non-allowlisted Playwright capabilities", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "import { chromium } from '@playwright/test'; await chromium.connectOverCDP('ws://example.com');",
      "page.route('**/*', () => {});",
      "page.screenshot();",
      "Reflect.apply(page.goto, page, ['/']);"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected"
      });
    }
  });

  it("rejects unmodelled control flow, allocation, and module-load code", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "while (true) {}",
      "import { expect, test } from '@playwright/test'; test('x', async ({ page }) => { while (true) {} });",
      "import { expect, test } from '@playwright/test'; test('x', async ({ page }) => { new Array(1_000_000_000); });",
      deepTitleTest(20_000),
      deepLiteralTest("array", 2_000),
      deepLiteralTest("object", 2_000)
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects unsupported result chains and matcher signatures", async () => {
    const worktree = await createWorktree();
    for (const content of [
      generatedTest("await page.waitForSelector('button').getByRole('button'); await page.click('button'); await expect(true).toBe(true);"),
      generatedTest("await page.click('button'); await expect(true).toBeVisible('unexpected');")
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects empty, incomplete, aliased, and un-awaited generated tests", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "import { expect, test } from '@playwright/test'; test('x', async ({ page }) => {});",
      "import { expect, test } from '@playwright/test'; test('x', async ({ page }) => { await expect(true).toBe(true); });",
      "import { expect, test } from '@playwright/test'; test('x', async ({ page }) => { await page.click('button'); });",
      "import { expect, test as pwTest } from '@playwright/test'; pwTest('x', async ({ page }) => { await page.click('button'); await expect(true).toBe(true); });",
      "import { expect, test } from '@playwright/test'; test('x', async ({ page }) => { await page.click('button'); expect(true).toBe(true); });"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({ status: "rejected" });
    }
  });

  it.runIf(process.platform !== "win32")("requires a private investigation-owned worktree", async () => {
    const worktree = await createWorktree();
    await chmod(worktree, 0o755);
    await expect(stageGeneratedTest(worktree, validTest)).resolves.toMatchObject({
      status: "failed", failure: { code: "write_failed" }
    });
  });
  it.runIf(process.platform !== "win32")("rejects a symlinked tests directory", async () => {
    const worktree = await createWorktree();
    const victim = await createWorktree();
    await symlink(victim, join(worktree, "tests"));
    await expect(stageGeneratedTest(worktree, validTest)).resolves.toMatchObject({
      status: "failed", failure: { code: "write_failed" }
    });
    await expect(readFile(join(victim, "generated", "failspec.generated.spec.ts"), "utf8")).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")("rejects a symlinked generated-test directory", async () => {
    const worktree = await createWorktree();
    const victim = await createWorktree();
    await mkdir(join(worktree, "tests"));
    await symlink(victim, join(worktree, "tests", "generated"));
    await expect(stageGeneratedTest(worktree, validTest)).resolves.toMatchObject({
      status: "failed", failure: { code: "write_failed" }
    });
    await expect(readFile(join(victim, "failspec.generated.spec.ts"), "utf8")).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")("does not overwrite a symlinked generated-test file", async () => {
    const worktree = await createWorktree();
    const victim = join(await createWorktree(), "victim.spec.ts");
    await mkdir(join(worktree, "tests", "generated"), { recursive: true });
    await writeFile(victim, "unchanged", "utf8");
    await symlink(victim, join(worktree, stagedGeneratedTestPath));

    await expect(stageGeneratedTest(worktree, validTest)).resolves.toMatchObject({
      status: "failed", failure: { code: "write_failed" }
    });
    await expect(readFile(victim, "utf8")).resolves.toBe("unchanged");
  });

  it("does not overwrite a hard-linked generated-test file", async () => {
    const worktree = await createWorktree();
    const victim = join(await createWorktree(), "victim.spec.ts");
    await mkdir(join(worktree, "tests", "generated"), { recursive: true });
    await writeFile(victim, "unchanged", "utf8");
    await link(victim, join(worktree, stagedGeneratedTestPath));

    await expect(stageGeneratedTest(worktree, validTest)).resolves.toMatchObject({
      status: "failed", failure: { code: "write_failed" }
    });
    await expect(readFile(victim, "utf8")).resolves.toBe("unchanged");
  });
});

async function createWorktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "failspec-runner-"));
  directories.push(directory);
  return directory;
}

function generatedTest(body: string): string {
  return `import { expect, test } from '@playwright/test'; test('checkout', async ({ page, request }) => { ${body} });`;
}

function capabilityStatement(capability: typeof generatedTestCapabilities[number]): string {
  if (capability.receiver === "page") {
    const call = `page.${capability.method}(${capabilityArguments(capability)})`;
    return `await ${call}; await page.click('button'); await expect(true).toBe(true);`;
  }
  if (capability.receiver === "request") {
    return `await request.${capability.method}(${capabilityArguments(capability)}); await page.click('button'); await expect(true).toBe(true);`;
  }
  if (capability.receiver === "locator") {
    return `await page.locator('button').${capability.method}(${capabilityArguments(capability)}); await expect(true).toBe(true);`;
  }
  return `await page.click('button'); await ${expectationExpression(capability)}.${capability.method}(${capabilityArguments(capability)});`;
}

function invalidCapabilityStatements(capability: typeof generatedTestCapabilities[number]): string[] {
  const receiver = capabilityReceiver(capability);
  const argument = capabilityArguments(capability);
  const statements = [
    `await ${wrongReceiver(capability)}.${capability.method}(${argument})`,
    `await ${receiver}.unsupported(${argument})`,
    `await ${receiver}['${capability.method}'](${argument})`
  ];
  if (capability.minimumArguments > 0) {
    statements.push(`await ${receiver}.${capability.method}(${argumentsForCount(capability, capability.minimumArguments - 1)})`);
  }
  statements.push(`await ${receiver}.${capability.method}(${argumentsForCount(capability, capability.maximumArguments + 1)})`);
  if (capability.arguments === "local_target") {
    statements.push(
      `await ${receiver}.${capability.method}('https://example.com')`,
      `await ${receiver}.${capability.method}(target)`
    );
  }
  if (capability.receiver === "expect") {
    statements.push(`await expect(${capability.expectationValue === "literal" ? "page.locator('button')" : "true"}).${capability.method}(${argument})`);
  }
  return statements;
}

function capabilityReceiver(capability: typeof generatedTestCapabilities[number]): string {
  if (capability.receiver === "locator") {
    return "page.locator('button')";
  }
  return capability.receiver === "expect" ? "expect(true)" : capability.receiver;
}

function capabilityArguments(capability: typeof generatedTestCapabilities[number]): string {
  if (capability.receiver === "expect" && capability.method === "toMatchObject") {
    return "{ value: 'value' }";
  }
  return argumentsForCount(capability, capability.minimumArguments);
}

function expectationExpression(capability: typeof generatedTestCapabilities[number]): string {
  if (capability.expectationValue === "locator") {
    return "expect(page.locator('button'))";
  }
  if (capability.expectationValue === "page") {
    return "expect(page)";
  }
  return capability.method === "toMatchObject" ? "expect({ value: 'value' })" : "expect('value')";
}

function argumentsForCount(capability: typeof generatedTestCapabilities[number], count: number): string {
  if (count === 0) {
    return "";
  }
  const values = capability.arguments === "local_target"
    ? ["'/api'", "'value'"]
    : capability.arguments === "selector_value"
      ? ["'button'", "'value'"]
      : capability.arguments === "selector"
        ? ["'button'"]
        : ["'value'"];
  return Array.from({ length: count }, (_, index) => values[index] ?? "'extra'").join(", ");
}

function wrongReceiver(capability: typeof generatedTestCapabilities[number]): string {
  if (capability.receiver === "request") {
    return "page";
  }
  if (capability.receiver === "expect") {
    return "page";
  }
  return "request";
}

function deepTitleTest(terms: number): string {
  return `import { expect, test } from '@playwright/test'; test(${Array.from({ length: terms }, () => "'x'").join(" + ")}, async ({ page }) => { await page.click('button'); await expect(true).toBe(true); });`;
}

function deepLiteralTest(kind: "array" | "object", depth: number): string {
  const literal = kind === "array"
    ? `${"[".repeat(depth)}'value'${"]".repeat(depth)}`
    : `${"{ value: ".repeat(depth)}'value'${" }".repeat(depth)}`;
  return generatedTest(`await page.click(${literal}); await expect(true).toBe(true);`);
}
