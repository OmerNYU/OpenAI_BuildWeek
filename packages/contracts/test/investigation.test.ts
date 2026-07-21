import { describe, expect, it } from "vitest";
import {
  codexAnalysisResultSchema,
  codexFailureCategorySchema,
  executionResultSchema,
  generatedTestStagingResultSchema,
  investigationRequestSchema,
  investigationSchema,
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

describe("investigationSchema", () => {
  it("accepts only the finite sanitized Codex failure categories", () => {
    expect(codexFailureCategorySchema.safeParse("invalid_generated_test_output").success).toBe(true);
    expect(codexFailureCategorySchema.safeParse("C:/secret/diagnostic").success).toBe(false);
  });

  it("accepts stored records created before analysis evidence was persisted", () => {
    expect(
      investigationSchema.safeParse({
        id: "investigation-1",
        status: "created",
        request: {
          repositoryPath: "C:/repos/example",
          bugTitle: "Checkout fails",
          bugDescription: "Checkout does not complete.",
          expectedBehavior: "Checkout completes.",
          actualBehavior: "Checkout remains open."
        },
        timeline: [
          { status: "created", at: "2026-07-19T00:00:00.000Z", message: "Investigation created." }
        ],
        createdAt: "2026-07-19T00:00:00.000Z",
        updatedAt: "2026-07-19T00:00:00.000Z"
      }).success
    ).toBe(true);
  });

  it("persists execution evidence separately while keeping it optional", () => {
    const result = investigationSchema.parse({
      id: "investigation-2",
      status: "execution_error",
      request: {
        repositoryPath: "C:/repos/example",
        bugTitle: "Checkout fails",
        bugDescription: "Checkout does not complete.",
        expectedBehavior: "Checkout completes.",
        actualBehavior: "Checkout remains open."
      },
      timeline: [
        { status: "created", at: "2026-07-19T00:00:00.000Z", message: "Investigation created." },
        { status: "execution_error", at: "2026-07-19T00:01:00.000Z", message: "Execution evidence collected." }
      ],
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:01:00.000Z",
      executionEvidence: {
        testStatus: "failed",
        assertionFailureMessage: "Expected confirmation page.",
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: [".failspec/runner/artifacts/trace.zip"]
      }
    });

    expect(result.executionEvidence?.testStatus).toBe("failed");
  });

  it("accepts optional structured verification and preserves supporting-signal order", () => {
    const result = investigationSchema.parse({
      id: "investigation-3",
      status: "partial",
      request: { repositoryPath: "C:/repos/example", bugTitle: "Checkout fails", bugDescription: "Checkout does not complete.", expectedBehavior: "Checkout completes.", actualBehavior: "Checkout remains open." },
      timeline: [{ status: "partial", at: "2026-07-19T00:00:00.000Z", message: "Investigation completed with partial evidence." }],
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
      verification: {
        verdict: "partial",
        explanation: "Evidence is incomplete.",
        recommendedNextStep: "Refine the scenario.",
        supportingSignals: [{ type: "first", message: "First signal." }, { type: "second", message: "Second signal." }]
      }
    });

    expect(result.verification?.supportingSignals.map((signal) => signal.type)).toEqual(["first", "second"]);
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

  it("rejects analysis with a missing evidence field", () => {
    expect(codexAnalysisResultSchema.safeParse({ hypothesis }).success).toBe(false);
  });

  it("accepts an empty evidence array", () => {
    expect(codexAnalysisResultSchema.safeParse({ hypothesis, evidence: [] }).success).toBe(true);
  });

  it("rejects evidence source paths outside the relevant files", () => {
    const result = codexAnalysisResultSchema.safeParse({
      hypothesis,
      evidence: [{ sourcePath: "src/unrelated.ts", observation: "This file is unrelated." }]
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ message: "Evidence source path must be a relevant file" })
      );
    }
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
    expect(verificationResultSchema.safeParse({ verdict: "verified", explanation: "Valid.", recommendedNextStep: "Continue.", supportingSignals: [{ type: "", message: "Invalid signal." }] }).success).toBe(false);
    expect(verificationResultSchema.safeParse({ verdict: "verified", explanation: "Valid.", recommendedNextStep: "Continue.", supportingSignals: [{ type: "signal", message: "x".repeat(2_001) }] }).success).toBe(false);
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
