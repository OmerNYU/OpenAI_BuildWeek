import { describe, expect, it } from "vitest";
import type {
  ExecutionEvidence,
  ExecutionResult,
  VerificationResult
} from "@failspec/contracts";
import { verificationResultSchema } from "@failspec/contracts";
import { classifyVerification, type VerificationInput } from "../src/index.js";

const hypothesis: VerificationInput["hypothesis"] = {
  summary: "Checkout validation is missing.",
  confidence: "high",
  relevantFiles: [{ path: "src/checkout.tsx", reason: "It renders checkout." }],
  reproductionSteps: ["Open checkout.", "Submit the form."],
  expectedFailureSignal: "Validation message is missing.",
  assumptions: []
};

function input(overrides: {
  hypothesis?: Partial<VerificationInput["hypothesis"]>;
  generatedTest?: Partial<VerificationInput["generatedTest"]>;
  execution?: Partial<ExecutionResult>;
  evidence?: Partial<ExecutionEvidence>;
} = {}): VerificationInput {
  return {
    hypothesis: { ...hypothesis, ...overrides.hypothesis },
    generatedTest: {
      path: "tests/generated/failspec.generated.spec.ts",
      content: "import { expect, test } from '@playwright/test';",
      ...overrides.generatedTest
    },
    execution: {
      command: "controlled_playwright_generated_test",
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      durationMs: 1,
      artifacts: [],
      ...overrides.execution
    },
    evidence: {
      testStatus: "passed",
      consoleErrors: [],
      pageErrors: [],
      artifactPaths: [],
      ...overrides.evidence
    }
  };
}

function classify(value: VerificationInput): VerificationResult {
  return classifyVerification(value);
}

describe("verification classification", () => {
  it("classifies a normally passed generated test as not reproduced", () => {
    const result = classify(input());

    expect(result.verdict).toBe("not_reproduced");
    expect(result.supportingSignals).toContainEqual({ type: "test_status", message: "Playwright test status: passed." });
  });

  it.each([
    ["timed out execution", input({ execution: { timedOut: true, exitCode: null }, evidence: { testStatus: "timedOut" } })],
    ["timed out test status", input({ evidence: { testStatus: "timedOut" } })],
    ["interrupted test status", input({ evidence: { testStatus: "interrupted" } })],
    ["unknown test status", input({ evidence: { testStatus: "unknown" } })],
    ["missing test status", input({ execution: { exitCode: 0 }, evidence: { testStatus: undefined } })],
    ["missing exit code", input({ execution: { exitCode: null } })],
    ["passed test with non-zero exit", input({ execution: { exitCode: 1 } })],
    ["failed test with zero exit", input({ execution: { exitCode: 0 }, evidence: { testStatus: "failed" } })],
    ["skipped test with non-zero exit", input({ execution: { exitCode: 1 }, evidence: { testStatus: "skipped" } })]
  ])("classifies %s as an execution error", (_name, value) => {
    expect(classify(value).verdict).toBe("execution_error");
  });

  it.each([
    [
      "a controlled execution timeout",
      input({
        execution: {
          command: "npx playwright test --secret-command",
          exitCode: 0,
          timedOut: true,
          stdout: "raw runner stdout",
          stderr: "raw runner stderr"
        }
      }),
      [
        { type: "execution_timeout", message: "Controlled execution timed out." },
        { type: "exit_code", message: "Controlled execution exit code: 0." }
      ]
    ],
    [
      "a passed status with a non-zero exit",
      input({ execution: { exitCode: 1 } }),
      [{ type: "exit_code", message: "Controlled execution exit code: 1." }]
    ],
    [
      "a failed status with a zero exit",
      input({ execution: { exitCode: 0 }, evidence: { testStatus: "failed" } }),
      [{ type: "exit_code", message: "Controlled execution exit code: 0." }]
    ],
    [
      "a missing exit code",
      input({ execution: { exitCode: null } }),
      [{ type: "exit_code", message: "Controlled execution did not report an exit code." }]
    ]
  ])("exposes safe decisive facts for %s", (_name, value, expectedSignals) => {
    const result = classify(value);

    expect(result.verdict).toBe("execution_error");
    expect(result.supportingSignals).toEqual(expect.arrayContaining(expectedSignals));
    for (const rawValue of ["npx playwright test --secret-command", "raw runner stdout", "raw runner stderr"]) {
      expect(result.supportingSignals.map((signal) => signal.message)).not.toContain(rawValue);
    }
  });

  it("classifies normally completed failed and skipped tests as partial", () => {
    expect(classify(input({ execution: { exitCode: 1 }, evidence: { testStatus: "failed" } })).verdict).toBe("partial");
    expect(classify(input({ execution: { exitCode: 0 }, evidence: { testStatus: "skipped" } })).verdict).toBe("partial");
  });

  it("explains a skipped test without claiming its body completed", () => {
    const result = classify(input({ execution: { exitCode: 0 }, evidence: { testStatus: "skipped" } }));

    expect(result.explanation).toBe("The generated test was skipped, so the reported bug could not be verified.");
    expect(result.explanation).not.toContain("completed");
  });

  it("keeps optional evidence out of verdict selection while exposing bounded supporting signals", () => {
    const value = input({
      execution: { exitCode: 1 },
      evidence: {
        testStatus: "failed",
        assertionFailureMessage: "Expected validation message to be visible.",
        expectedValue: "Validation message",
        actualValue: "No message",
        failureLocation: { file: "tests/checkout.spec.ts", line: 24, column: 9 },
        consoleErrors: ["Checkout request failed."],
        pageErrors: ["Unhandled page error."],
        artifactPaths: [".failspec/runner/artifacts/trace.zip"]
      }
    });

    const result = classify(value);

    expect(result.verdict).toBe("partial");
    expect(result.supportingSignals).toEqual(expect.arrayContaining([
      { type: "assertion_failure", message: "Expected validation message to be visible." },
      { type: "expected_value", message: "Expected value: Validation message" },
      { type: "actual_value", message: "Actual value: No message" },
      { type: "failure_location", message: "Failure location: tests/checkout.spec.ts:24:9" },
      { type: "console_error", message: "Checkout request failed." },
      { type: "page_error", message: "Unhandled page error." },
      { type: "artifact_path", message: ".failspec/runner/artifacts/trace.zip" }
    ]));
    expect(result.supportingSignals.every((signal) => signal.message.length <= 2_000)).toBe(true);
    expect(verificationResultSchema.parse(result)).toEqual(result);
  });

  it.each([
    ["a URI-scheme path", "file:///private/failspec/worktree/trace.zip"],
    ["a URI-scheme Windows path", "file://C:/Users/hassan/worktree/trace.zip"],
    ["an HTTPS path", "https://example.com/trace.zip"],
    ["a slash-rooted path", "/private/failspec/worktree/trace.zip"],
    ["a backslash-rooted path", "\\\\server\\share\\trace.zip"],
    ["a Windows drive path", "C:\\Users\\hassan\\trace.zip"],
    ["a Windows drive path with slash separators", "C:/Users/hassan/worktree/trace.zip"],
    ["a slash traversal path", "test-results/../secret.zip"],
    ["a backslash traversal path", "test-results\\..\\secret.zip"]
  ])("omits %s from every path-derived signal", (_description, unsafePath) => {
    const result = classify(input({
      execution: { exitCode: 1 },
      evidence: {
        testStatus: "failed",
        failureLocation: { file: unsafePath, line: 24, column: 9 },
        artifactPaths: ["test-results/trace.zip", unsafePath, "test-results/screenshot.png"]
      }
    }));

    expect(result.supportingSignals.some((signal) => signal.type === "failure_location")).toBe(false);
    expect(result.supportingSignals.filter((signal) => signal.type === "artifact_path")).toEqual([
      { type: "artifact_path", message: "test-results/trace.zip" },
      { type: "artifact_path", message: "test-results/screenshot.png" }
    ]);
  });

  it("preserves safe relative path signals unchanged and ordered", () => {
    const result = classify(input({
      execution: { exitCode: 1 },
      evidence: {
        testStatus: "failed",
        failureLocation: { file: "tests/checkout.spec.ts", line: 24, column: 9 },
        artifactPaths: [
          "test-results/trace.zip",
          ".failspec/runner/artifacts/screenshot.png",
          "screenshots/result..old.png"
        ]
      }
    }));

    expect(result.supportingSignals).toContainEqual({
      type: "failure_location",
      message: "Failure location: tests/checkout.spec.ts:24:9"
    });
    expect(result.supportingSignals.filter((signal) => signal.type === "artifact_path")).toEqual([
      { type: "artifact_path", message: "test-results/trace.zip" },
      { type: "artifact_path", message: ".failspec/runner/artifacts/screenshot.png" },
      { type: "artifact_path", message: "screenshots/result..old.png" }
    ]);
  });

  it("caps presentable evidence without letting it affect the verdict", () => {
    const result = classify(input({
      execution: { exitCode: 1 },
      evidence: {
        testStatus: "failed",
        assertionFailureMessage: "x".repeat(2_001),
        consoleErrors: Array.from({ length: 20 }, (_, index) => `Console error ${index + 1}.`),
        pageErrors: [],
        artifactPaths: []
      }
    }));

    expect(result.verdict).toBe("partial");
    expect(result.supportingSignals).toHaveLength(10);
    expect(result.supportingSignals.find((signal) => signal.type === "assertion_failure")?.message).toHaveLength(2_000);
  });

  it("verifies a failed generated test with a structured assertion mismatch", () => {
    const value = input({
      execution: { exitCode: 1 },
      hypothesis: { expectedFailureSignal: "Expected Charged total: $24.00 but received a different total." },
      generatedTest: { content: "await expect(page.getByRole('status')).toHaveText('Charged total: $24.00');" },
      evidence: {
        testStatus: "failed",
        testTitle: "checkout charges the selected quantity",
        assertionFailureMessage: hypothesis.expectedFailureSignal,
        expectedValue: "Charged total: $24.00",
        actualValue: "Charged total: $12.00"
      }
    });

    expect(classify(value)).toEqual(classify(value));
    expect(classify(value)).toMatchObject({ verdict: "verified" });
  });

  it.each([
    [
      "the hypothesis does not name the expected value",
      { hypothesis: { expectedFailureSignal: "The checkout total is wrong." } }
    ],
    [
      "the staged generated test does not contain the expected assertion",
      { generatedTest: { content: "await page.getByRole('button', { name: 'Complete checkout' }).click();" } }
    ]
  ])("keeps a structured mismatch partial when %s", (_name, handoff) => {
    expect(classify(input({
      execution: { exitCode: 1 },
      hypothesis: { expectedFailureSignal: "Expected Charged total: $24.00 but received a different total.", ...handoff.hypothesis },
      generatedTest: { content: "await expect(page.getByRole('status')).toHaveText('Charged total: $24.00');", ...handoff.generatedTest },
      evidence: {
        testStatus: "failed",
        testTitle: "checkout charges the selected quantity",
        assertionFailureMessage: "assertion",
        expectedValue: "Charged total: $24.00",
        actualValue: "Charged total: $12.00"
      }
    }))).toMatchObject({ verdict: "partial" });
  });

  it.each([
    ["no test title", { evidence: { testStatus: "failed", assertionFailureMessage: "assertion", expectedValue: "expected", actualValue: "actual" } }],
    ["no assertion message", { evidence: { testStatus: "failed", testTitle: "generated", expectedValue: "expected", actualValue: "actual" } }],
    ["no expected value", { evidence: { testStatus: "failed", testTitle: "generated", assertionFailureMessage: "assertion", actualValue: "actual" } }],
    ["equal structured values", { evidence: { testStatus: "failed", testTitle: "generated", assertionFailureMessage: "assertion", expectedValue: "same", actualValue: "same" } }]
  ])("keeps a failed test partial with %s", (_name, overrides) => {
    expect(classify(input({ execution: { exitCode: 1 }, ...overrides }))).toMatchObject({ verdict: "partial" });
  });
});
