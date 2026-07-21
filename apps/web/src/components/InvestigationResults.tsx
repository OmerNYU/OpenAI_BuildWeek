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
      {investigation.verdictExplanation ? <p><strong>Verdict:</strong> {investigation.verdictExplanation}</p> : null}
      {investigation.recommendedNextStep ? <p><strong>Next step:</strong> {investigation.recommendedNextStep}</p> : null}
    </div>
  );
}
