import { describe, expect, it } from "vitest";
import {
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
        failure: { code: "dirty_repository", message: "Repository has uncommitted changes." }
      })
    ).toMatchObject({ status: "unsupported" });
    expect(
      worktreePreparationResultSchema.parse({
        status: "failed",
        failure: { code: "creation_failed", message: "Unable to prepare worktree." }
      })
    ).toMatchObject({ status: "failed" });
    expect(
      generatedTestStagingResultSchema.parse({
        status: "rejected",
        failure: { code: "disallowed_import", message: "Generated test import is not allowed." }
      })
    ).toMatchObject({ status: "rejected" });
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
