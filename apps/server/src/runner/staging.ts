import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { GeneratedTestStagingResult } from "@failspec/contracts";
import * as ts from "typescript";

export const stagedGeneratedTestPath = "tests/generated/failspec.generated.spec.ts";
const maximumGeneratedTestBytes = 256 * 1024;
const forbiddenIdentifiers = new Set([
  "child_process",
  "fs",
  "net",
  "dgram",
  "worker_threads",
  "module",
  "process",
  "global",
  "globalThis",
  "eval",
  "Function",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "require"
]);
const forbiddenModuleNames = new Set([
  "child_process",
  "node:child_process",
  "fs",
  "node:fs",
  "net",
  "node:net",
  "dgram",
  "node:dgram",
  "worker_threads",
  "node:worker_threads"
]);
const dangerousMemberNames = new Set([
  "getBuiltinModule",
  "require",
  "eval",
  "Function",
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource"
]);
const requestMethodNames = new Set(["fetch", "get", "post", "put", "patch", "delete", "head"]);

export async function stageGeneratedTest(
  worktreePath: string,
  content: string
): Promise<GeneratedTestStagingResult> {
  if (Buffer.from(content, "utf8").toString("utf8") !== content) {
    return rejected("invalid_encoding");
  }
  if (Buffer.byteLength(content, "utf8") > maximumGeneratedTestBytes) {
    return rejected("file_too_large");
  }

  const sourceFile = ts.createSourceFile(stagedGeneratedTestPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = ts.transpileModule(content, {
    compilerOptions: { target: ts.ScriptTarget.Latest },
    reportDiagnostics: true
  }).diagnostics;
  if (diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    return rejected("typescript_parse_failed");
  }
  const validation = validateSource(sourceFile);
  if (validation === "import") {
    return rejected("disallowed_import");
  }
  if (validation === "api") {
    return rejected("disallowed_api");
  }

  const root = await canonicalDirectory(worktreePath);
  if (!root) {
    return failed("write_failed");
  }
  const destination = join(root, stagedGeneratedTestPath);
  try {
    const testsDirectory = await ownedDirectory(root, "tests");
    const destinationDirectory = testsDirectory && await ownedDirectory(testsDirectory, "generated");
    if (!destinationDirectory) {
      return failed("write_failed");
    }
    const existing = await lstat(destination).catch(() => undefined);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      return failed("write_failed");
    }
    const handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(content, "utf8");
    await handle.close();
    return { status: "staged", stagedTestPath: stagedGeneratedTestPath };
  } catch {
    return failed("write_failed");
  }
}

function validateSource(sourceFile: ts.SourceFile): "import" | "api" | undefined {
  let result: "import" | "api" | undefined;
  const visit = (node: ts.Node) => {
    if (result) {
      return;
    }
    if (ts.isImportDeclaration(node)) {
      if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "@playwright/test") {
        result = "import";
        return;
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) ||
      ts.isImportTypeNode(node) ||
      (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) ||
      (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
    ) {
      result = "import";
      return;
    }
    if (ts.isCallExpression(node) && (isUnsafePlaywrightCall(node) || hasDynamicPlaywrightMember(node))) {
      const target = node.arguments[0] && staticString(node.arguments[0]);
      if (hasDynamicPlaywrightMember(node) || !target || !isLocalTarget(target)) {
        result = "api";
        return;
      }
    }
    if (ts.isIdentifier(node) && forbiddenIdentifiers.has(node.text)) {
      result = "api";
      return;
    }
    if (ts.isStringLiteral(node)) {
      if (forbiddenModuleNames.has(node.text)) {
        result = "import";
        return;
      }
      if (isExternalHttpUrl(node.text)) {
        result = "api";
        return;
      }
    }
    if (
      dangerousMemberNames.has(memberName(node) ?? "") ||
      (ts.isElementAccessExpression(node) &&
        memberName(node) === undefined &&
        hasSensitiveRoot(node.expression))
    ) {
      result = "api";
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) {
    return node.name.text;
  }
  if (ts.isElementAccessExpression(node)) {
    return node.argumentExpression && stringValue(node.argumentExpression);
  }
  return undefined;
}

function isUnsafePlaywrightCall(node: ts.CallExpression): boolean {
  const name = memberName(node.expression);
  if (name === "goto") {
    return true;
  }
  return name !== undefined && requestMethodNames.has(name) && isRequestReceiver(receiver(node.expression));
}

function hasDynamicPlaywrightMember(node: ts.CallExpression): boolean {
  return ts.isElementAccessExpression(node.expression) &&
    memberName(node.expression) === undefined &&
    isPageOrRequestReceiver(node.expression.expression);
}

function receiver(node: ts.Node): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) ? node.expression : undefined;
}

function isRequestReceiver(node: ts.Expression | undefined): boolean {
  return Boolean(node && ((ts.isIdentifier(node) && node.text === "request") ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "request")));
}

function isPageOrRequestReceiver(node: ts.Expression): boolean {
  return (ts.isIdentifier(node) && (node.text === "page" || node.text === "request")) ||
    (ts.isPropertyAccessExpression(node) && node.name.text === "request");
}

function hasSensitiveRoot(node: ts.Expression): boolean {
  let current: ts.Expression = node;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) && ["module", "process", "globalThis", "global"].includes(current.text);
}

function staticString(node: ts.Expression): string | undefined {
  const literal = stringValue(node);
  if (literal !== undefined) {
    return literal;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function stringValue(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function isLocalTarget(target: string): boolean {
  if (target.startsWith("/") || target.startsWith("./") || target.startsWith("../") || target.startsWith("?") || target.startsWith("#")) {
    return true;
  }
  try {
    const url = new URL(target);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  } catch {
    return false;
  }
}

async function ownedDirectory(parent: string, name: string): Promise<string | undefined> {
  const path = join(parent, name);
  let entry = await lstat(path).catch(() => undefined);
  if (!entry) {
    await mkdir(path);
    entry = await lstat(path);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    return undefined;
  }
  const canonicalPath = await realpath(path);
  return isInside(parent, canonicalPath) ? canonicalPath : undefined;
}

function isExternalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname !== "127.0.0.1" && url.hostname !== "localhost";
  } catch {
    return false;
  }
}

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const canonicalPath = await realpath(path);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

function rejected(code: "invalid_encoding" | "file_too_large" | "typescript_parse_failed" | "disallowed_import" | "disallowed_api") {
  return { status: "rejected" as const, failure: { code } };
}

function failed(code: "write_failed") {
  return { status: "failed" as const, failure: { code } };
}
