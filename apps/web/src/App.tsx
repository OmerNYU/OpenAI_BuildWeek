import { useEffect, useRef, useState } from "react";
import type { Investigation, InvestigationRequest } from "@failspec/contracts";
import { createInvestigation, getInvestigation, InvestigationApiError } from "./api/investigations";
import { BugReportForm } from "./components/BugReportForm";
import { InvestigationProgress, isTerminal } from "./components/InvestigationProgress";
import { InvestigationResults } from "./components/InvestigationResults";

const defaultPollIntervalMs = 1_000;

export function App({ pollIntervalMs = defaultPollIntervalMs }: { pollIntervalMs?: number }) {
  const [investigation, setInvestigation] = useState<Investigation>();
  const [creationError, setCreationError] = useState<string>();
  const [pollingError, setPollingError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const timerRef = useRef<number>();
  const pollAbortRef = useRef<AbortController>();
  const runTokenRef = useRef(0);
  const investigationId = investigation?.id;
  const investigationStatus = investigation?.status;

  const hasNonTerminalInvestigation = Boolean(investigation && !isTerminal(investigation.status));
  const shouldPoll = hasNonTerminalInvestigation && !pollingError;

  useEffect(() => {
    if (!investigationId || !investigationStatus || !shouldPoll) {
      return;
    }

    let cancelled = false;
    const runToken = runTokenRef.current;
    const expectedInvestigationId = investigationId;
    const schedulePoll = () => {
      timerRef.current = window.setTimeout(async () => {
        const controller = new AbortController();
        pollAbortRef.current = controller;
        try {
          const next = await getInvestigation(expectedInvestigationId, controller.signal);
          if (cancelled || runToken !== runTokenRef.current) {
            return;
          }
          if (next.id !== expectedInvestigationId) {
            setPollingError("Unable to refresh investigation progress. Start another investigation to retry.");
            return;
          }
          setInvestigation(next);
          if (!isTerminal(next.status)) {
            schedulePoll();
          }
        } catch (error) {
          if (!cancelled && runToken === runTokenRef.current && !(error instanceof DOMException && error.name === "AbortError")) {
            setPollingError(safeErrorMessage(error, "Unable to refresh investigation progress. Start another investigation to retry."));
          }
        } finally {
          if (!cancelled) {
            pollAbortRef.current = undefined;
          }
        }
      }, pollIntervalMs);
    };

    schedulePoll();
    return () => {
      cancelled = true;
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      pollAbortRef.current?.abort();
      pollAbortRef.current = undefined;
    };
  }, [investigationId, investigationStatus, pollIntervalMs, shouldPoll]);

  async function submit(request: InvestigationRequest) {
    const runToken = ++runTokenRef.current;
    setCreationError(undefined);
    setPollingError(undefined);
    setCreating(true);
    try {
      const created = await createInvestigation(request);
      if (runToken === runTokenRef.current) {
        setInvestigation(created);
      }
    } catch (error) {
      if (runToken === runTokenRef.current) {
        setCreationError(safeErrorMessage(error, "Unable to start the investigation. Try again."));
      }
    } finally {
      if (runToken === runTokenRef.current) {
        setCreating(false);
      }
    }
  }

  function reset() {
    runTokenRef.current += 1;
    pollAbortRef.current?.abort();
    if (timerRef.current !== undefined) {
      window.clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
    setInvestigation(undefined);
    setCreationError(undefined);
    setPollingError(undefined);
    setCreating(false);
    setFormKey((value) => value + 1);
  }

  return (
    <main className="app-shell">
      <header className="app-header">
        <p className="eyebrow">Local-first investigation</p>
        <h1>FailSpec</h1>
        <p className="lede">Turn a clear failure report into an evidence-backed Playwright regression result.</p>
      </header>
      <section className="intake-section" aria-labelledby="bug-intake-heading">
        <SectionHeading number="01" title="Describe the failure" description="Tell FailSpec what happened and what you expected instead." id="bug-intake-heading" />
        <aside className="trust-note" aria-label="Repository requirements">
          <strong>Before you start</strong>
          <span>Use a trusted, clean local Git repository. FailSpec investigates an isolated worktree and never changes your submitted source checkout.</span>
        </aside>
        <BugReportForm
          key={formKey}
          disabled={creating || hasNonTerminalInvestigation}
          submitting={creating}
          submissionError={creationError}
          onSubmit={submit}
        />
      </section>
      <section aria-labelledby="investigation-progress-heading">
        <SectionHeading number="02" title="Follow the investigation" description="Watch the safe, server-reported stages as FailSpec works." id="investigation-progress-heading" />
        <InvestigationProgress
          investigation={investigation}
          pollingError={pollingError}
          pollIntervalMs={pollIntervalMs}
        />
      </section>
      <section aria-labelledby="results-heading">
        <SectionHeading number="03" title="Review the result" description="Separate file-backed analysis, execution evidence, and the verification verdict." id="results-heading" />
        <InvestigationResults investigation={investigation} />
      </section>
      {investigation ? <button className="secondary-button" type="button" onClick={reset}>Start another investigation</button> : null}
    </main>
  );
}

function SectionHeading({ number, title, description, id }: { number: string; title: string; description: string; id: string }) {
  return (
    <div className="section-heading">
      <span aria-hidden="true">{number}</span>
      <div>
        <h2 id={id}>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof InvestigationApiError ? error.message : fallback;
}
