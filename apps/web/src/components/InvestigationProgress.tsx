import { useEffect, useState } from "react";
import {
  terminalInvestigationStatuses,
  type Investigation,
  type InvestigationStatus
} from "@failspec/contracts";

const terminalStatuses = new Set<InvestigationStatus>(terminalInvestigationStatuses);

export function isTerminal(status: InvestigationStatus): boolean {
  return terminalStatuses.has(status);
}

const workflowSteps: InvestigationStatus[] = [
  "preflight",
  "analyzing",
  "hypothesis_ready",
  "generating_test",
  "test_ready",
  "executing"
];

export function InvestigationProgress({ investigation, pollingError, pollIntervalMs = 1_000 }: {
  investigation?: Investigation;
  pollingError?: string;
  pollIntervalMs?: number;
}) {
  if (!investigation) {
    return <p>Submit a bug report to begin an investigation.</p>;
  }

  const terminal = isTerminal(investigation.status);
  const latestEvent = investigation.timeline.at(-1);
  const currentStep = workflowSteps.indexOf(investigation.status);
  const completedSteps = terminal ? workflowSteps.length : Math.max(0, currentStep);
  const progressValue = terminal ? workflowSteps.length : Math.max(0, currentStep + 1);
  return (
    <div className="investigation-progress" aria-busy={!terminal && !pollingError}>
      <p><strong>Investigation ID:</strong> {investigation.id}</p>
      <p className="progress-summary" role="status" aria-live="polite">
        {!terminal ? <span className="spinner" aria-hidden="true" /> : null}
        <span>
          <strong>Status:</strong> {readableStatus(investigation.status)} ({terminal ? "Terminal" : "Processing"})
          {latestEvent ? ` — ${latestEvent.message}` : ""}
        </span>
      </p>
      <div className="progress-meta">
        <span><strong>Status:</strong> {readableStatus(investigation.status)}</span>
        <ElapsedTime investigation={investigation} terminal={terminal} />
        {!terminal && !pollingError ? <span>Live updates every {formatPollInterval(pollIntervalMs)}.</span> : null}
      </div>
      <div
        className="progress-track"
        role="progressbar"
        aria-label="Investigation progress"
        aria-valuemin={0}
        aria-valuemax={workflowSteps.length}
        aria-valuenow={progressValue}
      >
        <span style={{ width: `${(progressValue / workflowSteps.length) * 100}%` }} />
      </div>
      <ol className="progress-steps" aria-label="Investigation stages">
        {workflowSteps.map((step, index) => (
          <li className={index < completedSteps ? "complete" : index === currentStep && !terminal ? "current" : "pending"} key={step}>
            {readableStatus(step)}
          </li>
        ))}
      </ol>
      {pollingError ? <p className="form-error" role="alert">{pollingError}</p> : null}
      <h3>Live investigation log</h3>
      <ol className="timeline" aria-label="Investigation timeline">
        {investigation.timeline.map((event, index) => (
          <li className={index === investigation.timeline.length - 1 ? "latest" : undefined} key={`${event.at}-${index}`}>
            <strong>{readableStatus(event.status)}{index === investigation.timeline.length - 1 ? " · Current" : ""}</strong>
            <span>{event.message}</span>
            <time dateTime={event.at}>{readableTime(event.at)}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ElapsedTime({ investigation, terminal }: { investigation: Investigation; terminal: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (terminal) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [terminal]);

  const startedAt = new Date(investigation.createdAt).getTime();
  const endedAt = terminal ? new Date(investigation.updatedAt).getTime() : now;
  if (Number.isNaN(startedAt) || Number.isNaN(endedAt)) {
    return null;
  }
  return <span><strong>{terminal ? "Duration:" : "Elapsed:"}</strong> {formatElapsed(Math.max(0, endedAt - startedAt))}</span>;
}

function readableStatus(status: InvestigationStatus): string {
  return status.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function readableTime(timestamp: string): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString();
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function formatPollInterval(milliseconds: number): string {
  return milliseconds % 1_000 === 0 ? `${milliseconds / 1_000} second${milliseconds === 1_000 ? "" : "s"}` : `${milliseconds} milliseconds`;
}
