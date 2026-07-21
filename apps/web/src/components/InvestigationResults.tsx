import type { Investigation } from "@failspec/contracts";
import { isTerminal } from "./InvestigationProgress";

export function InvestigationResults({ investigation }: { investigation?: Investigation }) {
  if (!investigation || !isTerminal(investigation.status)) {
    return <p>Results will appear when the investigation reaches a terminal status.</p>;
  }

  const isExecutionError = investigation.status === "execution_error";
  const isOperationalExecutionError = isExecutionError && investigation.verification === undefined;
  return (
    <div className={isExecutionError ? "result result-error" : "result"}>
      <p><strong>{isOperationalExecutionError ? "Execution failure" : "Terminal status"}:</strong> {investigation.status.replaceAll("_", " ")}</p>
      {investigation.codexFailureCategory ? <p><strong>Codex response:</strong> {formatCodexFailure(investigation.codexFailureCategory)}</p> : null}
      {investigation.hypothesis ? (
        <>
          <p><strong>Hypothesis:</strong> {investigation.hypothesis.summary}</p>
          <p><strong>Confidence:</strong> {investigation.hypothesis.confidence}</p>
          {investigation.hypothesis.relevantFiles.length ? (
            <ul>
              {investigation.hypothesis.relevantFiles.map((file) => (
                <li key={file.path}><code>{file.path}</code>: {file.reason}</li>
              ))}
            </ul>
          ) : null}
          <section className="analysis-evidence" aria-labelledby="analysis-evidence-heading">
            <h3 id="analysis-evidence-heading">Analysis evidence</h3>
            <p className="analysis-evidence-intro">File-backed repository observations that support this hypothesis. These observations are not execution results or proof that the bug was reproduced.</p>
            {investigation.analysisEvidence?.length ? (
              <ul className="analysis-evidence-list" aria-label="Analysis evidence">
                {investigation.analysisEvidence.map((evidence, index) => (
                  <li key={`${evidence.sourcePath}-${index}`}><code>{evidence.sourcePath}</code>: {evidence.observation}</li>
                ))}
              </ul>
            ) : <p>No file-backed analysis evidence was recorded for this investigation.</p>}
          </section>
        </>
      ) : null}
      {investigation.generatedTestPath ? <p><strong>Generated test path:</strong> {investigation.generatedTestPath}</p> : null}
      <ExecutionEvidenceSection evidence={investigation.executionEvidence} />
      {investigation.verification ? <VerificationResultSection verification={investigation.verification} /> : (
        <>
          {investigation.verdictExplanation && !investigation.codexFailureCategory ? <p><strong>Verdict:</strong> {investigation.verdictExplanation}</p> : null}
          {investigation.recommendedNextStep ? <p><strong>Next step:</strong> {investigation.recommendedNextStep}</p> : null}
        </>
      )}
    </div>
  );
}

function formatCodexFailure(category: NonNullable<Investigation["codexFailureCategory"]>): string {
  const labels = {
    cli_failed: "Codex CLI was unavailable or did not complete.",
    invalid_analysis_output: "Codex analysis did not match the required format.",
    invalid_generated_test_output: "Codex generated a test outside the approved policy."
  };
  return labels[category];
}

function VerificationResultSection({ verification }: { verification: NonNullable<Investigation["verification"]> }) {
  return (
    <section className="verification-result" aria-labelledby="verification-result-heading">
      <h3 id="verification-result-heading">Verification result</h3>
      <p className="verification-result-intro">Deterministic classification of the validated execution evidence collected from the generated test.</p>
      <dl className="verification-result-details">
        <dt>Verdict</dt>
        <dd>{formatVerificationVerdict(verification.verdict)}</dd>
        <dt>Explanation</dt>
        <dd>{verification.explanation}</dd>
        <dt>Recommended next step</dt>
        <dd>{verification.recommendedNextStep}</dd>
      </dl>
      {verification.supportingSignals.length ? (
        <div>
          <h4>Supporting signals</h4>
          <p className="verification-signals-intro">Bounded, structured signals that explain the classified result.</p>
          <ul className="verification-signals-list" aria-label="Supporting signals">
            {verification.supportingSignals.map((signal, index) => (
              <li key={`${signal.type}-${index}`}><strong>{formatVerificationSignalType(signal.type)}:</strong> {isPathSignal(signal.type) ? <code>{signal.message}</code> : signal.message}</li>
            ))}
          </ul>
        </div>
      ) : <p>No additional supporting signals were recorded.</p>}
    </section>
  );
}

function ExecutionEvidenceSection({ evidence }: { evidence?: Investigation["executionEvidence"] }) {
  const safeFailureLocation = evidence?.failureLocation && isSafeRelativeEvidencePath(evidence.failureLocation.file)
    ? evidence.failureLocation
    : undefined;
  const safeArtifactPaths = evidence?.artifactPaths.filter(isSafeRelativeEvidencePath) ?? [];
  const hasAssertionSummary = evidence?.expectedValue !== undefined && evidence.actualValue !== undefined;
  const hasDefinitionDetails = Boolean(evidence && (
    evidence.testTitle !== undefined ||
    evidence.testStatus !== undefined ||
    evidence.assertionFailureMessage !== undefined ||
    evidence.expectedValue !== undefined ||
    evidence.actualValue !== undefined ||
    safeFailureLocation !== undefined
  ));
  const hasListDetails = Boolean(evidence && (
    evidence.consoleErrors.length > 0 ||
    evidence.pageErrors.length > 0 ||
    safeArtifactPaths.length > 0
  ));
  const hasDetails = hasDefinitionDetails || hasListDetails;

  return (
    <section className="execution-evidence" aria-labelledby="execution-evidence-heading">
      <h3 id="execution-evidence-heading">Execution evidence</h3>
      <p className="execution-evidence-intro">Structured, sanitized observations collected while running the generated test. These are execution facts, not the final verification verdict.</p>
      {!hasDetails || !evidence ? <p>No structured execution evidence was recorded for this investigation.</p> : (
        <>
          {hasDefinitionDetails ? <dl className="execution-evidence-details">
            {evidence.testTitle !== undefined ? <><dt>Test title</dt><dd>{evidence.testTitle}</dd></> : null}
            {evidence.testStatus !== undefined ? <><dt>Test status</dt><dd>{formatTestStatus(evidence.testStatus)}</dd></> : null}
            {hasAssertionSummary ? <><dt>Expected</dt><dd>{evidence.expectedValue}</dd><dt>Received</dt><dd>{evidence.actualValue}</dd></> : null}
            {evidence.assertionFailureMessage !== undefined ? (
              hasAssertionSummary ? <><dt>Assertion details</dt><dd><details><summary>Show technical assertion details</summary><p>{evidence.assertionFailureMessage}</p></details></dd></> : <><dt>Assertion failure</dt><dd>{evidence.assertionFailureMessage}</dd></>
            ) : null}
            {!hasAssertionSummary && evidence.expectedValue !== undefined ? <><dt>Expected value</dt><dd>{evidence.expectedValue}</dd></> : null}
            {!hasAssertionSummary && evidence.actualValue !== undefined ? <><dt>Actual value</dt><dd>{evidence.actualValue}</dd></> : null}
            {safeFailureLocation ? <><dt>Failure location</dt><dd><code>{safeFailureLocation.file}</code>{safeFailureLocation.line !== undefined ? `:${safeFailureLocation.line}` : ""}{safeFailureLocation.column !== undefined ? `:${safeFailureLocation.column}` : ""}</dd></> : null}
          </dl> : null}
          {evidence.consoleErrors.length ? <EvidenceList label="Console errors" items={evidence.consoleErrors} /> : null}
          {evidence.pageErrors.length ? <EvidenceList label="Page errors" items={evidence.pageErrors} /> : null}
          {safeArtifactPaths.length ? <EvidenceList label="Artifact paths" items={safeArtifactPaths} codeItems /> : null}
        </>
      )}
    </section>
  );
}

function EvidenceList({ label, items, codeItems = false }: { label: string; items: string[]; codeItems?: boolean }) {
  return (
    <div>
      <h4>{label}</h4>
      <ul className="execution-evidence-list" aria-label={label}>
        {items.map((item, index) => <li key={`${item}-${index}`}>{codeItems ? <code>{item}</code> : item}</li>)}
      </ul>
    </div>
  );
}

function formatTestStatus(status: string): string {
  return status.replace(/([A-Z])/g, " $1").toLowerCase();
}

function formatVerificationVerdict(verdict: NonNullable<Investigation["verification"]>["verdict"]): string {
  const labels = {
    verified: "Verified",
    partial: "Partial evidence",
    not_reproduced: "Not reproduced",
    execution_error: "Execution error"
  };
  return labels[verdict];
}

function formatVerificationSignalType(type: string): string {
  const readable = type.replaceAll("_", " ");
  return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`;
}

function isPathSignal(type: string): boolean {
  return type === "failure_location" || type === "artifact_path";
}

function isSafeRelativeEvidencePath(value: string): boolean {
  const hasSchemePrefix = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
  const hasAbsolutePrefix = value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value);
  const hasTraversalSegment = value.split(/[\\/]+/).some((segment) => segment === "..");
  return !hasSchemePrefix && !hasAbsolutePrefix && !hasTraversalSegment;
}
