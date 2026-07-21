import type {
  ExecutionEvidence,
  ExecutionResult,
  ReproductionHypothesis,
  VerificationResult,
  VerificationSignal
} from "@failspec/contracts";

export interface VerificationInput {
  hypothesis: ReproductionHypothesis;
  execution: ExecutionResult;
  evidence: ExecutionEvidence;
}

const maximumSupportingSignals = 10;
const maximumSignalTextLength = 2_000;

export function classifyVerification(input: VerificationInput): VerificationResult {
  void input.hypothesis;

  const verdict = classifyVerdict(input.execution, input.evidence);
  return {
    verdict,
    ...verdictDetails(verdict, input.evidence),
    supportingSignals: supportingSignals(input.execution, input.evidence)
  };
}

function classifyVerdict(execution: ExecutionResult, evidence: ExecutionEvidence): VerificationResult["verdict"] {
  const status = evidence.testStatus;
  if (
    execution.timedOut ||
    execution.exitCode === null ||
    status === undefined ||
    status === "timedOut" ||
    status === "interrupted" ||
    status === "unknown"
  ) {
    return "execution_error";
  }

  if (
    (status === "passed" && execution.exitCode !== 0) ||
    (status === "failed" && execution.exitCode === 0) ||
    (status === "skipped" && execution.exitCode !== 0)
  ) {
    return "execution_error";
  }

  return status === "passed" ? "not_reproduced" : "partial";
}

function verdictDetails(
  verdict: VerificationResult["verdict"],
  evidence: ExecutionEvidence
): Pick<VerificationResult, "explanation" | "recommendedNextStep"> {
  if (verdict === "not_reproduced") {
    return {
      explanation: "The generated test completed without reproducing the expected failure.",
      recommendedNextStep: "Review the hypothesis and generated test, then retry with a more specific reproduction."
    };
  }
  if (verdict === "partial") {
    return {
      explanation: evidence.testStatus === "skipped"
        ? "The generated test was skipped, so the reported bug could not be verified."
        : "The generated test failed, but the available evidence cannot safely verify the reported bug.",
      recommendedNextStep: "Review the recorded execution evidence and refine the reproduction test."
    };
  }
  return {
    explanation: "The generated test did not produce a complete, internally consistent execution result.",
    recommendedNextStep: "Resolve the execution issue and retry the investigation."
  };
}

function supportingSignals(execution: ExecutionResult, evidence: ExecutionEvidence): VerificationSignal[] {
  const signals: VerificationSignal[] = [];
  const add = (type: string, message: string | undefined) => {
    if (message && signals.length < maximumSupportingSignals) {
      signals.push({ type, message: bounded(message) });
    }
  };

  add("execution_timeout", execution.timedOut ? "Controlled execution timed out." : undefined);
  add("exit_code", execution.exitCode === null
    ? "Controlled execution did not report an exit code."
    : `Controlled execution exit code: ${execution.exitCode}.`);
  add("test_status", `Playwright test status: ${evidence.testStatus ?? "missing"}.`);
  add("test_title", evidence.testTitle && `Generated test: ${evidence.testTitle}`);
  add("assertion_failure", evidence.assertionFailureMessage);
  add("expected_value", evidence.expectedValue && `Expected value: ${evidence.expectedValue}`);
  add("actual_value", evidence.actualValue && `Actual value: ${evidence.actualValue}`);
  add("failure_location", evidence.failureLocation && `Failure location: ${formatLocation(evidence.failureLocation)}`);
  for (const message of evidence.consoleErrors) add("console_error", message);
  for (const message of evidence.pageErrors) add("page_error", message);
  for (const path of evidence.artifactPaths) add("artifact_path", path);
  return signals;
}

function formatLocation(location: NonNullable<ExecutionEvidence["failureLocation"]>): string {
  return `${location.file}${location.line === undefined ? "" : `:${location.line}`}${location.column === undefined ? "" : `:${location.column}`}`;
}

function bounded(value: string): string {
  return value.slice(0, maximumSignalTextLength);
}
