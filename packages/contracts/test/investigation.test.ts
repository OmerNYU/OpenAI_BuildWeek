import { describe, expect, it } from "vitest";
import {
  codexAnalysisResultSchema,
  executionResultSchema,
  generatedTestStagingResultSchema,
  investigationRequestSchema,
  repositoryPreflightResultSchema,
  runnerOutputSchema,
  verificationResultSchema,
  worktreePreparationResultSchema
} from "../src/investigation.js";

describe("investigationRequestSchema", () => {
  it("rejects required whitespace-only fields", () => {
    expect(
      investigationRequestSchema.safeParse({
        repositoryPath: "  ",
        bugTitle: "Title",
        bugDescription: "Description",
        expectedBehavior: "Expected",
        actualBehavior: "Actual"
      }).success
    ).toBe(false);
  });
});

describe("Codex analysis contracts", () => {
  const hypothesis = {
    summary: "Checkout does not show the validation error.",
    confidence: "high" as const,
    relevantFiles: [{ path: "src/checkout.tsx", reason: "It renders the checkout form." }],
    reproductionSteps: ["Open checkout.", "Submit an empty form."],
    expectedFailureSignal: "The required-field message is missing.",
    assumptions: ["The local app starts successfully."]
  };

  it("trims evidence values", () => {
    expect(
      codexAnalysisResultSchema.parse({
        hypothesis,
        evidence: [
          {
            sourcePath: " src/checkout.tsx ",
            observation: " submit handler has no error state "
          }
        ]
      }).evidence
    ).toEqual([
      {
        sourcePath: "src/checkout.tsx",
        observation: "submit handler has no error state"
      }
    ]);
  });

  it("rejects evidence observations longer than 2,000 characters", () => {
    expect(
      codexAnalysisResultSchema.safeParse({
        hypothesis,
        evidence: [{ sourcePath: "src/checkout.tsx", observation: "x".repeat(2_001) }]
      }).success
    ).toBe(false);
  });
});

describe("execution contracts", () => {
  const execution = {
    command: "npx playwright test",
    exitCode: 1,
    timedOut: false,
    stdout: "",
    stderr: "Assertion failed",
    durationMs: 42,
    artifacts: ["test-results/trace.zip"]
  };

  it("keeps ExecutionResult compatible and separates execution evidence", () => {
    expect(executionResultSchema.parse(execution)).toEqual(execution);
    expect(
      runnerOutputSchema.parse({
        execution,
        evidence: {
          testTitle: "checkout completes",
          testStatus: "failed",
          assertionFailureMessage: "Expected confirmation page",
          expectedValue: "/confirmation",
          actualValue: "/checkout",
          failureLocation: { file: "tests/checkout.spec.ts", line: 18, column: 7 },
          consoleErrors: ["Checkout failed"],
          pageErrors: [],
          artifactPaths: ["test-results/trace.zip"]
        }
      })
    ).toMatchObject({ execution, evidence: { testStatus: "failed" } });
  });

  it("accepts typed operational failures without treating them as verification", () => {
    expect(
      repositoryPreflightResultSchema.parse({
        status: "unsupported",
        failure: { code: "dirty_repository" }
      })
    ).toMatchObject({ status: "unsupported" });
    expect(
      worktreePreparationResultSchema.parse({
        status: "failed",
        failure: { code: "creation_failed" }
      })
    ).toMatchObject({ status: "failed" });
    expect(
      generatedTestStagingResultSchema.parse({
        status: "rejected",
        failure: { code: "disallowed_import" }
      })
    ).toMatchObject({ status: "rejected" });
    expect(
      repositoryPreflightResultSchema.safeParse({
        status: "unsupported",
        failure: { code: "dirty_repository", message: "raw internal error" }
      }).success
    ).toBe(false);
  });

  it("rejects invalid execution and verification data", () => {
    expect(
      runnerOutputSchema.safeParse({
        execution,
        evidence: { consoleErrors: [], pageErrors: [], artifactPaths: [], testStatus: "broken" }
      }).success
    ).toBe(false);
    expect(
      verificationResultSchema.safeParse({
        verdict: "failed",
        explanation: "A test failed.",
        recommendedNextStep: "Inspect it.",
        supportingSignals: []
      }).success
    ).toBe(false);
  });

  it("models verification separately from a non-zero execution result", () => {
    expect(
      verificationResultSchema.parse({
        verdict: "execution_error",
        explanation: "The runner could not execute the test.",
        recommendedNextStep: "Resolve the runner failure and retry.",
        supportingSignals: [{ type: "runner_failure", message: "Browser launch failed." }]
      }).verdict
    ).toBe("execution_error");
  });
});
