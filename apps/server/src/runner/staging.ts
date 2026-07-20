import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import type { GeneratedTestStagingResult } from "@failspec/contracts";
import * as ts from "typescript";

export const stagedGeneratedTestPath = "tests/generated/failspec.generated.spec.ts";
const maximumGeneratedTestBytes = 256 * 1024;
type CapabilityReceiver = "page" | "request" | "locator" | "expect";
type CapabilityArguments = "literal" | "local_target";
type CapabilityResult = "void" | "locator" | "assertion";

interface GeneratedTestCapability {
  receiver: CapabilityReceiver;
  method: string;
  arguments: CapabilityArguments;
  result: CapabilityResult;
  interaction?: true;
}

export const generatedTestCapabilities: readonly GeneratedTestCapability[] = [
  { receiver: "page", method: "goto", arguments: "local_target", result: "void", interaction: true },
  ...["blur", "check", "click", "dblclick", "fill", "focus", "hover", "press", "selectOption", "type", "uncheck"].map((method) => ({ receiver: "page" as const, method, arguments: "literal" as const, result: "void" as const, interaction: true as const })),
  ...["getByAltText", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "getByTitle", "locator", "waitForSelector"].map((method) => ({ receiver: "page" as const, method, arguments: "literal" as const, result: "locator" as const })),
  ...["fetch", "get", "post", "put", "patch", "delete", "head"].map((method) => ({ receiver: "request" as const, method, arguments: "local_target" as const, result: "void" as const })),
  ...["blur", "check", "click", "dblclick", "fill", "focus", "hover", "press", "selectOption", "type", "uncheck"].map((method) => ({ receiver: "locator" as const, method, arguments: "literal" as const, result: "void" as const, interaction: true as const })),
  ...["toBe", "toBeChecked", "toBeEnabled", "toBeHidden", "toBeVisible", "toContain", "toContainText", "toEqual", "toHaveText", "toHaveURL", "toHaveValue", "toMatch", "toMatchObject"].map((method) => ({ receiver: "expect" as const, method, arguments: "literal" as const, result: "assertion" as const }))
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
  const expectCall = expression.expression;
  return ts.isCallExpression(expectCall) && ts.isIdentifier(expectCall.expression) && expectCall.expression.text === "expect" && expectCall.arguments.length === 1 && isExpectationValue(expectCall.arguments[0]);
}

function isExpectationValue(node: ts.Expression): boolean {
  return isLiteralValue(node) || capabilityReceiver(node) === "page" || capabilityReceiver(node) === "locator";
}

function isLiteralValue(node: ts.Expression): boolean {
  if (staticString(node) !== undefined || ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword || node.kind === ts.SyntaxKind.NullKeyword) {
    return true;
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => ts.isExpression(element) && isLiteralValue(element));
  }
  return ts.isObjectLiteralExpression(node) && node.properties.every((property) => ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && isLiteralValue(property.initializer));
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
  if (!statement || !ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== "@playwright/test" || statement.importClause?.isTypeOnly) {
    return false;
  }
  const bindings = statement.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 2) {
    return false;
  }
  return new Set(bindings.elements.map((specifier) => !specifier.propertyName ? specifier.name.text : "")).size === 2 &&
    bindings.elements.every((specifier) => !specifier.propertyName && (specifier.name.text === "expect" || specifier.name.text === "test"));
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
