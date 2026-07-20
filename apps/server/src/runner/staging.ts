import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { GeneratedTestStagingResult } from "@failspec/contracts";
import * as ts from "typescript";

export const stagedGeneratedTestPath = "tests/generated/failspec.generated.spec.ts";
const maximumGeneratedTestBytes = 256 * 1024;
type CapabilityReceiver = "page" | "request" | "locator" | "expect";
type CapabilityArguments = "literal" | "local_target" | "selector" | "selector_value" | "value";
type CapabilityResult = "void" | "locator" | "assertion";
type ExpectationValue = "literal" | "locator" | "page";

interface GeneratedTestCapability {
  receiver: CapabilityReceiver;
  method: string;
  arguments: CapabilityArguments;
  result: CapabilityResult;
  interaction?: true;
  minimumArguments: number;
  maximumArguments: number;
  expectationValue?: ExpectationValue;
}

const pageSelectorActions = ["check", "click", "dblclick", "focus", "hover", "uncheck"] as const;
const locatorSelectorActions = ["blur", ...pageSelectorActions] as const;
const valueActions = ["fill", "press", "selectOption", "type"] as const;
export const generatedTestCapabilities: readonly GeneratedTestCapability[] = [
  { receiver: "page", method: "goto", arguments: "local_target", result: "void", interaction: true, minimumArguments: 1, maximumArguments: 1 },
  ...pageSelectorActions.map((method) => ({ receiver: "page" as const, method, arguments: "selector" as const, result: "void" as const, interaction: true as const, minimumArguments: 1, maximumArguments: 1 })),
  ...valueActions.map((method) => ({ receiver: "page" as const, method, arguments: "selector_value" as const, result: "void" as const, interaction: true as const, minimumArguments: 2, maximumArguments: 2 })),
  ...["getByAltText", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "getByTitle", "locator"].map((method) => ({ receiver: "page" as const, method, arguments: "value" as const, result: "locator" as const, minimumArguments: 1, maximumArguments: 1 })),
  ...["fetch", "get", "post", "put", "patch", "delete", "head"].map((method) => ({ receiver: "request" as const, method, arguments: "local_target" as const, result: "void" as const, minimumArguments: 1, maximumArguments: 1 })),
  ...locatorSelectorActions.map((method) => ({ receiver: "locator" as const, method, arguments: "literal" as const, result: "void" as const, interaction: true as const, minimumArguments: 0, maximumArguments: 0 })),
  ...valueActions.map((method) => ({ receiver: "locator" as const, method, arguments: "value" as const, result: "void" as const, interaction: true as const, minimumArguments: 1, maximumArguments: 1 })),
  ...["toBeChecked", "toBeEnabled", "toBeHidden", "toBeVisible"].map((method) => ({ receiver: "expect" as const, method, arguments: "literal" as const, result: "assertion" as const, minimumArguments: 0, maximumArguments: 0, expectationValue: "locator" as const })),
  ...["toBe", "toContain", "toEqual", "toMatch", "toMatchObject"].map((method) => ({ receiver: "expect" as const, method, arguments: "value" as const, result: "assertion" as const, minimumArguments: 1, maximumArguments: 1, expectationValue: "literal" as const })),
  ...["toContainText", "toHaveText", "toHaveValue"].map((method) => ({ receiver: "expect" as const, method, arguments: "value" as const, result: "assertion" as const, minimumArguments: 1, maximumArguments: 1, expectationValue: "locator" as const })),
  { receiver: "expect", method: "toHaveURL", arguments: "value", result: "assertion", minimumArguments: 1, maximumArguments: 1, expectationValue: "page" }
];

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

  try {
    const sourceFile = ts.createSourceFile(stagedGeneratedTestPath, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    if (parseDiagnostics.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
      return rejected("typescript_parse_failed");
    }
    const validation = validateSource(sourceFile);
    if (validation === "import") {
      return rejected("disallowed_import");
    }
    if (validation === "api") {
      return rejected("disallowed_api");
    }
  } catch {
    return rejected("disallowed_api");
  }

  const root = await canonicalDirectory(worktreePath);
  if (!root || !(await isPrivateWorktree(root))) {
    return failed("write_failed");
  }
  try {
    const testsDirectory = await ownedDirectory(root, "tests");
    const destinationDirectory = testsDirectory && await ownedDirectory(testsDirectory, "generated");
    if (!destinationDirectory) {
      return failed("write_failed");
    }
    const destination = join(destinationDirectory, basename(stagedGeneratedTestPath));
    const handle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    let created: Awaited<ReturnType<typeof handle.stat>> | undefined;
    let staged = false;
    try {
      created = await handle.stat();
      const resolvedDestination = await realpath(destination);
      const current = await stat(destination);
      if (resolvedDestination !== destination || created.dev !== current.dev || created.ino !== current.ino) {
        return failed("write_failed");
      }
      await handle.writeFile(content, "utf8");
      staged = true;
      return { status: "staged", stagedTestPath: stagedGeneratedTestPath };
    } finally {
      await handle.close();
      if (!staged && created) {
        await removeCreatedFile(destination, created);
      }
    }
  } catch {
    return failed("write_failed");
  }
}

function validateSource(sourceFile: ts.SourceFile): "import" | "api" | undefined {
  if (sourceFile.statements.some(ts.isImportDeclaration) && !isExactPlaywrightImport(sourceFile.statements[0])) {
    return "import";
  }
  if (sourceFile.statements.length !== 2 || !isExactPlaywrightImport(sourceFile.statements[0])) {
    return "api";
  }
  return isGeneratedTestCall(sourceFile.statements[1]) ? undefined : "api";
}

function isGeneratedTestCall(statement: ts.Statement): boolean {
  if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression) || !ts.isIdentifier(statement.expression.expression) || statement.expression.expression.text !== "test") {
    return false;
  }
  const [title, callback] = statement.expression.arguments;
  return statement.expression.arguments.length === 2 && staticString(title) !== undefined && callback !== undefined && isTestCallback(callback);
}

function isTestCallback(node: ts.Expression): boolean {
  if (!ts.isArrowFunction(node) || !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) || !ts.isBlock(node.body) || node.parameters.length !== 1) {
    return false;
  }
  const parameter = node.parameters[0];
  if (parameter.dotDotDotToken || parameter.initializer || parameter.type || !ts.isObjectBindingPattern(parameter.name)) {
    return false;
  }
  const names = parameter.name.elements.map((element) => !element.propertyName && !element.initializer && ts.isIdentifier(element.name) ? element.name.text : undefined);
  if (names.length === 0 || names.length > 2 || !names.includes("page") || names.some((name) => name !== "page" && name !== "request")) {
    return false;
  }
  let hasInteraction = false;
  let hasAssertion = false;
  for (const statement of node.body.statements) {
    const kind = classifyTestStatement(statement);
    if (!kind) {
      return false;
    }
    hasInteraction ||= kind === "interaction";
    hasAssertion ||= kind === "assertion";
  }
  return hasInteraction && hasAssertion;
}

function classifyTestStatement(statement: ts.Statement): "interaction" | "assertion" | "other" | undefined {
  if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression)) {
    return undefined;
  }
  const capability = capabilityCall(statement.expression.expression);
  if (capability) {
    return capability.interaction ? "interaction" : "other";
  }
  return isExpectation(statement.expression.expression) ? "assertion" : undefined;
}

function capabilityCall(node: ts.Expression): GeneratedTestCapability | undefined {
  if (!ts.isCallExpression(node) || !node.arguments.every(isLiteralValue)) {
    return undefined;
  }
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) {
    return undefined;
  }
  const receiver = capabilityReceiver(expression.expression);
  if (!receiver) {
    return undefined;
  }
  const capability = generatedTestCapabilities.find((candidate) => candidate.receiver === receiver && candidate.method === expression.name.text);
  if (!capability) {
    return undefined;
  }
  if (node.arguments.length < capability.minimumArguments || node.arguments.length > capability.maximumArguments) {
    return undefined;
  }
  if (capability.arguments === "local_target") {
    const target = node.arguments[0] && staticString(node.arguments[0]);
    return target !== undefined && isLocalTarget(target) ? capability : undefined;
  }
  return capability;
}

function capabilityReceiver(node: ts.Expression): "page" | "request" | "locator" | undefined {
  if (ts.isIdentifier(node)) {
    return node.text === "page" || node.text === "request" ? node.text : undefined;
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || !node.arguments.every(isLiteralValue)) {
    return undefined;
  }
  const capability = capabilityCall(node);
  return capability?.result === "locator" ? "locator" : undefined;
}

function isExpectation(node: ts.Expression): boolean {
  if (!ts.isCallExpression(node) || !node.arguments.every(isLiteralValue)) {
    return false;
  }
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression)) {
    return false;
  }
  const capability = generatedTestCapabilities.find((candidate) => candidate.receiver === "expect" && candidate.method === expression.name.text);
  if (!capability) {
    return false;
  }
  if (node.arguments.length < capability.minimumArguments || node.arguments.length > capability.maximumArguments) {
    return false;
  }
  const expectCall = expression.expression;
  return ts.isCallExpression(expectCall) && ts.isIdentifier(expectCall.expression) && expectCall.expression.text === "expect" && expectCall.arguments.length === 1 && expectationValue(expectCall.arguments[0]) === capability.expectationValue;
}

function expectationValue(node: ts.Expression): ExpectationValue | undefined {
  if (isLiteralValue(node)) {
    return "literal";
  }
  const receiver = capabilityReceiver(node);
  return receiver === "page" || receiver === "locator" ? receiver : undefined;
}

function isLiteralValue(node: ts.Expression): boolean {
  const pending: Array<{ node: ts.Expression; depth: number }> = [{ node, depth: 0 }];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > 64 || ++visited > 512) {
      return false;
    }
    if (staticString(current.node) !== undefined || ts.isNumericLiteral(current.node) || current.node.kind === ts.SyntaxKind.TrueKeyword || current.node.kind === ts.SyntaxKind.FalseKeyword || current.node.kind === ts.SyntaxKind.NullKeyword) {
      continue;
    }
    if (ts.isArrayLiteralExpression(current.node)) {
      for (const element of current.node.elements) {
        if (!ts.isExpression(element)) {
          return false;
        }
        pending.push({ node: element, depth: current.depth + 1 });
      }
      continue;
    }
    if (!ts.isObjectLiteralExpression(current.node)) {
      return false;
    }
    for (const property of current.node.properties) {
      if (!ts.isPropertyAssignment(property) || (!ts.isIdentifier(property.name) && !ts.isStringLiteral(property.name))) {
        return false;
      }
      pending.push({ node: property.initializer, depth: current.depth + 1 });
    }
  }
  return true;
}

function staticString(node: ts.Expression): string | undefined {
  const pending: ts.Expression[] = [node];
  const parts: string[] = [];
  while (pending.length > 0) {
    if (parts.length + pending.length > 256) {
      return undefined;
    }
    const current = pending.pop();
    if (!current) {
      return undefined;
    }
    const literal = stringValue(current);
    if (literal !== undefined) {
      parts.push(literal);
    } else if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      pending.push(current.right, current.left);
    } else {
      return undefined;
    }
  }
  return parts.join("");
}

function stringValue(node: ts.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : undefined;
}

function isLocalTarget(target: string): boolean {
  if (target.includes("\\") || target.startsWith("//")) {
    return false;
  }
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

function isExactPlaywrightImport(statement: ts.Statement | undefined): statement is ts.ImportDeclaration {
  if (!statement || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@playwright/test" || statement.importClause?.isTypeOnly || statement.importClause?.name) {
    return false;
  }
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 2) {
    return false;
  }
  return new Set(bindings.elements.map((specifier) => !specifier.propertyName ? specifier.name.text : "")).size === 2 &&
    bindings.elements.every((specifier) => !specifier.isTypeOnly && !specifier.propertyName && (specifier.name.text === "expect" || specifier.name.text === "test"));
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

async function canonicalDirectory(path: string): Promise<string | undefined> {
  try {
    const canonicalPath = await realpath(path);
    return (await stat(canonicalPath)).isDirectory() ? canonicalPath : undefined;
  } catch {
    return undefined;
  }
}

async function isPrivateWorktree(root: string): Promise<boolean> {
  if (process.platform === "win32") {
    return true;
  }
  const owner = process.getuid?.();
  const entry = await stat(root);
  return owner !== undefined && entry.uid === owner && (entry.mode & 0o077) === 0;
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path.length > 0 && !path.startsWith("..") && !isAbsolute(path);
}

async function removeCreatedFile(path: string, created: { dev: number | bigint; ino: number | bigint }): Promise<void> {
  try {
    const current = await lstat(path);
    if (current.dev === created.dev && current.ino === created.ino) {
      await unlink(path);
    }
  } catch {
    // The failed staging result is already sanitized; never remove a replacement.
  }
}

function rejected(code: "invalid_encoding" | "file_too_large" | "typescript_parse_failed" | "disallowed_import" | "disallowed_api") {
  return { status: "rejected" as const, failure: { code } };
}

function failed(code: "write_failed") {
  return { status: "failed" as const, failure: { code } };
}
