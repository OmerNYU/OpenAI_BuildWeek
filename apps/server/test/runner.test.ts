import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageGeneratedTest, stagedGeneratedTestPath } from "../src/runner/staging.js";

const directories: string[] = [];
const validTest = "import { expect, test } from '@playwright/test';\ntest('checkout', async ({ page }) => { await page.goto('/'); await page.click('button'); expect(true).toBe(true); });";

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

  it("rejects dynamic imports of forbidden Node modules", async () => {
    const worktree = await createWorktree();
    for (const module of ["node:child_process", "node:fs", "node:net", "node:worker_threads"]) {
      await expect(stageGeneratedTest(worktree, `await import('${module}');`)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_import" }
      });
    }
  });

  it("rejects forbidden module names in string literals", async () => {
    const worktree = await createWorktree();
    for (const module of ["child_process", "node:child_process", "fs", "node:fs", "net", "node:net", "dgram", "node:dgram", "worker_threads", "node:worker_threads"]) {
      await expect(stageGeneratedTest(worktree, `const moduleName = '${module}';`)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_import" }
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
    for (const content of ["module.require('./helper');", "module['require']('./helper');", "module[`require`]('./helper');"]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects forbidden APIs", async () => {
    const worktree = await createWorktree();
    await expect(stageGeneratedTest(worktree, "eval('1');")).resolves.toMatchObject({
      status: "rejected", failure: { code: "disallowed_api" }
    });
  });

  it("rejects indirect global eval access", async () => {
    const worktree = await createWorktree();
    for (const content of ["globalThis['eval']('1');", "globalThis[`eval`]('1');", "globalThis[eval]('1');"]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
  });

  it("rejects indirect global Function access", async () => {
    const worktree = await createWorktree();
    for (const content of ["globalThis['Function']('return 1')();", "globalThis[`Function`]('return 1')();"]) {
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

  it("allows only local static Playwright navigation and request targets", async () => {
    const worktree = await createWorktree();
    for (const content of ["page.goto('/checkout');", "page.goto('http://127.0.0.1:3100/');", "request.get('https://localhost/api');"]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({ status: "staged" });
    }
  });

  it("rejects external or dynamic Playwright navigation and request targets", async () => {
    const worktree = await createWorktree();
    for (const content of [
      "page.goto('https://' + 'example.com');",
      "page.goto(target);",
      "request.get(`https://example.com`);",
      "page.request.post('/api/' + endpoint);"
    ]) {
      await expect(stageGeneratedTest(worktree, content)).resolves.toMatchObject({
        status: "rejected", failure: { code: "disallowed_api" }
      });
    }
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
});

async function createWorktree(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "failspec-runner-"));
  directories.push(directory);
  return directory;
}
