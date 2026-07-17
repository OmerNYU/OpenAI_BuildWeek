import * as ts from "typescript";

export interface PlaywrightTestValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateGeneratedPlaywrightTest(
  content: string
): PlaywrightTestValidationResult {
  const sourceFile = ts.createSourceFile(
    "generated.spec.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const diagnostics = ts.transpileModule(content, {
    compilerOptions: { target: ts.ScriptTarget.Latest },
    reportDiagnostics: true
  }).diagnostics;

  if (diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)) {
    return { valid: false, errors: ["Generated test must be valid TypeScript"] };
  }

  const testNames = importedNames(sourceFile, "test");
  const expectNames = importedNames(sourceFile, "expect");
  let testCalls = 0;
  let hasInteraction = false;
  let hasAssertion = false;
  let hasShadowedTest = false;

  const visit = (node: ts.Node) => {
    if (
      (ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
      bindingUsesTestName(node.name, testNames)
    ) {
      hasShadowedTest = true;
    }

    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression) && testNames.has(node.expression.text)) {
        testCalls += 1;
      }

      if (ts.isIdentifier(node.expression) && expectNames.has(node.expression.text)) {
        hasAssertion = true;
      }

      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ["goto", "click", "fill", "check", "selectOption", "press"].includes(
          node.expression.name.text
        )
      ) {
        hasInteraction = true;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);

  const errors: string[] = [];

  if (testNames.size === 0) {
    errors.push("Generated test must import test from @playwright/test");
  }
  if (hasShadowedTest) {
    errors.push("Generated test must not shadow the Playwright test import");
  } else if (testCalls !== 1) {
    errors.push("Generated test must declare exactly one Playwright test");
  }
  if (!hasInteraction) {
    errors.push("Generated test must include a user interaction");
  }
  if (!hasAssertion) {
    errors.push("Generated test must include an assertion");
  }

  return { valid: errors.length === 0, errors };
}

function importedNames(sourceFile: ts.SourceFile, importedName: string): Set<string> {
  const names = new Set<string>();

  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@playwright/test" ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      continue;
    }

    for (const specifier of statement.importClause.namedBindings.elements) {
      const imported = specifier.propertyName?.text ?? specifier.name.text;

      if (imported === importedName) {
        names.add(specifier.name.text);
      }
    }
  }

  return names;
}

function bindingUsesTestName(name: ts.BindingName, testNames: Set<string>): boolean {
  if (ts.isIdentifier(name)) {
    return testNames.has(name.text);
  }

  return name.elements.some(
    (element) => ts.isBindingElement(element) && bindingUsesTestName(element.name, testNames)
  );
}
