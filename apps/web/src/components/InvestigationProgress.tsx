import type { Investigation, InvestigationStatus } from "@failspec/contracts";

const terminalStatuses = new Set<InvestigationStatus>([
  "verified",
  "partial",
  "not_reproduced",
  "execution_error"
]);

export function isTerminal(status: InvestigationStatus): boolean {
  return terminalStatuses.has(status);
}

export function InvestigationProgress({ investigation, pollingError }: {
  investigation?: Investigation;
  pollingError?: string;
}) {
  if (!investigation) {
    return <p>Submit a bug report to begin an investigation.</p>;
  }

  const terminal = isTerminal(investigation.status);
  return (
    <div className="investigation-progress">
      <p><strong>Investigation ID:</strong> {investigation.id}</p>
      <p role="status" aria-live="polite">
        <strong>Status:</strong> {readableStatus(investigation.status)} — {terminal ? "Terminal" : "Processing"}
      </p>
      {pollingError ? <p className="form-error" role="alert">{pollingError}</p> : null}
      <ol className="timeline" aria-label="Investigation timeline">
        {investigation.timeline.map((event, index) => (
          <li key={`${event.at}-${index}`}>
            <strong>{readableStatus(event.status)}</strong>
            <span>{event.message}</span>
            <time dateTime={event.at}>{readableTime(event.at)}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}

function readableStatus(status: InvestigationStatus): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readableTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}
