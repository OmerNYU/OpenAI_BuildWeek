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
      <header>
        <h1>FailSpec</h1>
        <p>From vague failures to verified tests.</p>
      </header>
      <section aria-labelledby="bug-intake-heading">
        <h2 id="bug-intake-heading">Bug intake</h2>
        <BugReportForm
          key={formKey}
          disabled={creating || hasNonTerminalInvestigation}
          submissionError={creationError}
          onSubmit={submit}
        />
      </section>
      <section aria-labelledby="investigation-progress-heading">
        <h2 id="investigation-progress-heading">Investigation progress</h2>
        <InvestigationProgress investigation={investigation} pollingError={pollingError} />
      </section>
      <section aria-labelledby="results-heading">
        <h2 id="results-heading">Results</h2>
        <InvestigationResults investigation={investigation} />
      </section>
      {investigation ? <button type="button" onClick={reset}>Start another investigation</button> : null}
    </main>
  );
}

function safeErrorMessage(error: unknown, fallback: string): string {
  return error instanceof InvestigationApiError ? error.message : fallback;
}
