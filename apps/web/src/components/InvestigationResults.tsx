import type { Investigation } from "@failspec/contracts";
import { isTerminal } from "./InvestigationProgress";

export function InvestigationResults({ investigation }: { investigation?: Investigation }) {
  if (!investigation || !isTerminal(investigation.status)) {
    return <p>Results will appear when the investigation reaches a terminal status.</p>;
  }

  const isExecutionError = investigation.status === "execution_error";
  return (
    <div className={isExecutionError ? "result result-error" : "result"}>
      <p><strong>{isExecutionError ? "Execution failure" : "Terminal status"}:</strong> {investigation.status.replaceAll("_", " ")}</p>
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
      {investigation.verdictExplanation ? <p><strong>Verdict:</strong> {investigation.verdictExplanation}</p> : null}
      {investigation.recommendedNextStep ? <p><strong>Next step:</strong> {investigation.recommendedNextStep}</p> : null}
    </div>
  );
}

function ExecutionEvidenceSection({ evidence }: { evidence?: Investigation["executionEvidence"] }) {
  const safeFailureLocation = evidence?.failureLocation && isSafeRelativeEvidencePath(evidence.failureLocation.file)
    ? evidence.failureLocation
    : undefined;
  const safeArtifactPaths = evidence?.artifactPaths.filter(isSafeRelativeEvidencePath) ?? [];
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
            {evidence.assertionFailureMessage !== undefined ? <><dt>Assertion failure</dt><dd>{evidence.assertionFailureMessage}</dd></> : null}
            {evidence.expectedValue !== undefined ? <><dt>Expected value</dt><dd>{evidence.expectedValue}</dd></> : null}
            {evidence.actualValue !== undefined ? <><dt>Actual value</dt><dd>{evidence.actualValue}</dd></> : null}
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

function isSafeRelativeEvidencePath(value: string): boolean {
  const hasAbsolutePrefix = value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value);
  const hasTraversalSegment = value.split(/[\\/]+/).some((segment) => segment === "..");
  return !hasAbsolutePrefix && !hasTraversalSegment;
}
