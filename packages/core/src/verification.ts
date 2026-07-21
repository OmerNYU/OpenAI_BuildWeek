import type {
  ExecutionEvidence,
  ExecutionResult,
  ReproductionHypothesis,
  VerificationResult,
  VerificationSignal
} from "@failspec/contracts";
import type { GeneratedTest } from "./adapters.js";

export interface VerificationInput {
  hypothesis: ReproductionHypothesis;
  generatedTest: GeneratedTest;
  execution: ExecutionResult;
  evidence: ExecutionEvidence;
}

const maximumSupportingSignals = 10;
const maximumSignalTextLength = 2_000;

export function classifyVerification(input: VerificationInput): VerificationResult {
  const verdict = classifyVerdict(input);
  return {
    verdict,
    ...verdictDetails(verdict, input.evidence),
    supportingSignals: supportingSignals(input.execution, input.evidence)
  };
}

function classifyVerdict(input: VerificationInput): VerificationResult["verdict"] {
  const { execution, evidence } = input;
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

  if (status === "passed") {
    return "not_reproduced";
  }
  return isVerifiedAssertion(input) ? "verified" : "partial";
}

function isVerifiedAssertion(input: VerificationInput): boolean {
  const { execution, evidence, hypothesis, generatedTest } = input;
  const expected = evidence.expectedValue;
  const actual = evidence.actualValue;
  return execution.exitCode === 1 &&
    evidence.testStatus === "failed" &&
    Boolean(evidence.testTitle) &&
    Boolean(evidence.assertionFailureMessage) &&
    expected !== undefined &&
    actual !== undefined &&
    expected !== actual &&
    Boolean(generatedTest.path) &&
    generatedTest.content.includes(expected) &&
    hypothesis.expectedFailureSignal.includes(expected);
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
  if (verdict === "verified") {
    return {
      explanation: "The generated regression test produced a structured assertion mismatch matching the reported behavior.",
      recommendedNextStep: "Review the generated regression test and implement a fix for the verified behavior."
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
  add(
    "failure_location",
    evidence.failureLocation && isSafeRelativePath(evidence.failureLocation.file)
      ? `Failure location: ${formatLocation(evidence.failureLocation)}`
      : undefined
  );
  for (const message of evidence.consoleErrors) add("console_error", message);
  for (const message of evidence.pageErrors) add("page_error", message);
  for (const path of evidence.artifactPaths) add("artifact_path", isSafeRelativePath(path) ? path : undefined);
  return signals;
}

function formatLocation(location: NonNullable<ExecutionEvidence["failureLocation"]>): string {
  return `${location.file}${location.line === undefined ? "" : `:${location.line}`}${location.column === undefined ? "" : `:${location.column}`}`;
}

function bounded(value: string): string {
  return value.slice(0, maximumSignalTextLength);
}

function isSafeRelativePath(value: string): boolean {
  const hasSchemePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
  const hasAbsolutePrefix = value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value);
  const hasTraversalSegment = value.split(/[\\/]+/).some((segment) => segment === "..");
  return !hasSchemePrefix && !hasAbsolutePrefix && !hasTraversalSegment;
}
