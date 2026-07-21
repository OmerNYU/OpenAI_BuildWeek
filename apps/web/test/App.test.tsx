import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  terminalInvestigationStatuses,
  type Investigation,
  type InvestigationRequest,
  type InvestigationStatus
} from "@failspec/contracts";
import { App } from "../src/App";
import { isTerminal } from "../src/components/InvestigationProgress";

const validRequest: InvestigationRequest = {
  repositoryPath: "C:/repos/checkout",
  bugTitle: "Checkout validation is missing",
  bugDescription: "The form submits without validation.",
  expectedBehavior: "A required message appears.",
  actualBehavior: "No validation message appears."
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("renders all required and optional bug-report fields", () => {
    render(<App />);

    expect(screen.getByLabelText("Repository path")).toBeTruthy();
    expect(screen.getByLabelText("Bug title")).toBeTruthy();
    expect(screen.getByLabelText("Bug description")).toBeTruthy();
    expect(screen.getByLabelText("Expected behavior")).toBeTruthy();
    expect(screen.getByLabelText("Actual behavior")).toBeTruthy();
    expect(screen.getByLabelText("Terminal log (optional)")).toBeTruthy();
    expect(screen.getByLabelText("Screenshot path (optional)")).toBeTruthy();
  });

  it("prevents client submission with blank required fields", () => {
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getAllByText("String must contain at least 1 character(s)").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Repository path").getAttribute("aria-invalid")).toBe("true");
  });

  it("submits normalized input and omits blank optional values", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified")));
    render(<App />);
    fillRequiredFields({ ...validRequest, repositoryPath: "  C:/repos/checkout  " });
    fireEvent.change(screen.getByLabelText("Terminal log (optional)"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await screen.findByText("Mock hypothesis");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/investigations");
    expect(JSON.parse(String(init.body))).toEqual(validRequest);
  });

  it("renders a terminal investigation returned directly by POST without polling", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified")));
    render(<App pollIntervalMs={10} />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await flushPromises();
    expect(screen.getByText("Mock hypothesis")).toBeTruthy();
    expect(screen.getByText(/The deterministic mock runner returned the expected reproduction signal\./)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Terminal status:/)).toBeTruthy();
  });

  it("renders file-backed analysis evidence under the terminal hypothesis", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      analysisEvidence: [{
        sourcePath: "src/checkout.tsx",
        observation: "The submit handler does not render a validation message."
      }]
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("list", { name: "Analysis evidence" });
    expect(screen.getByRole("heading", { name: "Analysis evidence" })).toBeTruthy();
    expect(within(evidence).getByText("src/checkout.tsx")).toBeTruthy();
    expect(within(evidence).getByRole("listitem").textContent).toContain("The submit handler does not render a validation message.");
    expect(screen.getByText(/not execution results or proof that the bug was reproduced/i)).toBeTruthy();
  });

  it("renders multiple observations even when they share a source path", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      analysisEvidence: [
        { sourcePath: "src/checkout.tsx", observation: "The form state starts without an error." },
        { sourcePath: "src/checkout.tsx", observation: "Submitting leaves the error state unchanged." }
      ]
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("list", { name: "Analysis evidence" });
    expect(within(evidence).getAllByText("src/checkout.tsx")).toHaveLength(2);
    expect(within(evidence).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("The form state starts without an error."),
      expect.stringContaining("Submitting leaves the error state unchanged.")
    ]);
  });

  it.each([
    ["omits", {}],
    ["has no entries in", { analysisEvidence: [] }]
  ])("shows the analysis-evidence fallback when the investigation %s analysisEvidence", async (_description, options) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, options)));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await screen.findByRole("heading", { name: "Analysis evidence" });
    expect(screen.getByText("No file-backed analysis evidence was recorded for this investigation.")).toBeTruthy();
  });

  it("renders preserved analysis evidence for an execution error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("execution_error", undefined, undefined, {
      analysisEvidence: [{
        sourcePath: "src/checkout.tsx",
        observation: "The missing validation state is preserved after submission."
      }]
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("list", { name: "Analysis evidence" });
    expect(screen.getByText(/Execution failure:/)).toBeTruthy();
    expect(within(evidence).getByRole("listitem").textContent).toContain("The missing validation state is preserved after submission.");
  });

  it("polls the investigation ID and renders updated timeline events in API order", async () => {
    vi.useFakeTimers();
    const created = makeInvestigation("analyzing", ["created", "preflight", "analyzing"]);
    const update = makeInvestigation("analyzing", ["created", "preflight", "analyzing"]);
    const completed = makeInvestigation("verified", ["created", "preflight", "analyzing", "verified"]);
    fetchMock
      .mockResolvedValueOnce(jsonResponse(created))
      .mockResolvedValueOnce(jsonResponse(update))
      .mockResolvedValueOnce(jsonResponse(completed));
    render(<App pollIntervalMs={10} />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await flushPromises();
    expect(screen.getByRole("status").textContent).toContain("Processing");
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
    expect(screen.getByText(/Terminal status:/)).toBeTruthy();
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/investigations/${created.id}`);
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`/api/investigations/${created.id}`);
    expect(within(screen.getByRole("list", { name: "Investigation timeline" })).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("Created"),
      expect.stringContaining("Preflight"),
      expect.stringContaining("Analyzing"),
      expect.stringContaining("Verified")
    ]);
  });

  it("recognizes every shared terminal investigation status", () => {
    expect(terminalInvestigationStatuses.every((status) => isTerminal(status))).toBe(true);
  });

  it.each(terminalInvestigationStatuses)(
    "stops polling when GET returns terminal status %s",
    async (status) => {
      vi.useFakeTimers();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(makeInvestigation("executing")))
        .mockResolvedValueOnce(jsonResponse(makeInvestigation(status)));
      render(<App pollIntervalMs={10} />);
      fillRequiredFields(validRequest);
      fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

      await flushPromises();
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(screen.getByRole("status").textContent).toMatch(new RegExp(status.replace("_", " "), "i"));
    }
  );

  it("renders a safe creation error for failed requests", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network failed"));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Unable to reach the investigation service. Try again.");
  });

  it("renders a safe malformed-response error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: true }));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    expect((await screen.findByRole("alert")).textContent).toContain("The investigation service returned an invalid response.");
  });

  it("does not expose a non-2xx response body", async () => {
    const sensitiveError = "Error: ENOENT C:\\Users\\secret\\repo at InvestigationService.run (...)";
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: sensitiveError }, 500));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Unable to start the investigation. Try again.");
    expect(screen.queryByText(sensitiveError)).toBeNull();
    expect(screen.queryByText(/C:\\Users\\secret\\repo/)).toBeNull();
    expect(screen.queryByText(/InvestigationService\.run/)).toBeNull();
  });

  it("shows a polling error while preserving the last investigation", async () => {
    vi.useFakeTimers();
    const created = makeInvestigation("analyzing");
    fetchMock.mockResolvedValueOnce(jsonResponse(created)).mockRejectedValueOnce(new Error("offline"));
    render(<App pollIntervalMs={10} />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await flushPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText("Unable to reach the investigation service. Try again.")).toBeTruthy();
    expect(screen.getByText(created.id)).toBeTruthy();
  });

  it("keeps the form disabled after a polling failure until reset enables a fresh submission", async () => {
    vi.useFakeTimers();
    const created = makeInvestigation("analyzing");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(created))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(jsonResponse(makeInvestigation("verified")));
    render(<App pollIntervalMs={10} />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await flushPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByRole("button", { name: "Start investigation" }).hasAttribute("disabled")).toBe(true);
    for (const label of fieldLabels) {
      expect(screen.getByLabelText(label).hasAttribute("disabled")).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Start another investigation" }));
    expect(screen.getByRole("button", { name: "Start investigation" }).hasAttribute("disabled")).toBe(false);
    expect((screen.getByLabelText("Repository path") as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText("Unable to reach the investigation service. Try again.")).toBeNull();
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(screen.getByText("Mock hypothesis")).toBeTruthy();
  });

  it("ignores an in-flight polling response after reset", async () => {
    vi.useFakeTimers();
    const created = makeInvestigation("analyzing");
    let resolvePollingResponse: (response: Response) => void = () => {};
    fetchMock
      .mockResolvedValueOnce(jsonResponse(created))
      .mockImplementationOnce(() => new Promise((resolve) => { resolvePollingResponse = resolve; }));
    render(<App pollIntervalMs={10} />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await flushPromises();
    await act(async () => {
      vi.advanceTimersByTime(10);
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Start another investigation" }));

    await act(async () => { resolvePollingResponse(jsonResponse(makeInvestigation("verified"))); });
    expect(screen.getByText("Submit a bug report to begin an investigation.")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a polling response with a mismatched investigation ID", async () => {
    vi.useFakeTimers();
    const created = makeInvestigation("analyzing", ["created", "analyzing"], "investigation-a");
    const mismatched = makeInvestigation("analyzing", ["created", "analyzing"], "investigation-b");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(created))
      .mockResolvedValueOnce(jsonResponse(mismatched));
    render(<App pollIntervalMs={10} />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await flushPromises();
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(screen.getByText(created.id)).toBeTruthy();
    expect(screen.queryByText(mismatched.id)).toBeNull();
    expect(screen.getByText("Unable to refresh investigation progress. Start another investigation to retry.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start investigation" }).hasAttribute("disabled")).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("resets form and investigation state without reloading", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified")));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));
    await screen.findByText("Mock hypothesis");
    fireEvent.click(screen.getByRole("button", { name: "Start another investigation" }));

    expect((screen.getByLabelText("Repository path") as HTMLInputElement).value).toBe("");
    expect(screen.getByText("Submit a bug report to begin an investigation.")).toBeTruthy();
  });

  it("prevents duplicate active submissions and clears polling on unmount", async () => {
    vi.useFakeTimers();
    let resolveCreation: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { resolveCreation = resolve; }));
    const view = render(<App pollIntervalMs={10} />);
    fillRequiredFields(validRequest);
    const submit = screen.getByRole("button", { name: "Start investigation" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => { resolveCreation(jsonResponse(makeInvestigation("analyzing"))); });
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function fillRequiredFields(request: InvestigationRequest) {
  fireEvent.change(screen.getByLabelText("Repository path"), { target: { value: request.repositoryPath } });
  fireEvent.change(screen.getByLabelText("Bug title"), { target: { value: request.bugTitle } });
  fireEvent.change(screen.getByLabelText("Bug description"), { target: { value: request.bugDescription } });
  fireEvent.change(screen.getByLabelText("Expected behavior"), { target: { value: request.expectedBehavior } });
  fireEvent.change(screen.getByLabelText("Actual behavior"), { target: { value: request.actualBehavior } });
}

const fieldLabels = [
  "Repository path",
  "Bug title",
  "Bug description",
  "Expected behavior",
  "Actual behavior",
  "Terminal log (optional)",
  "Screenshot path (optional)"
];

function makeInvestigation(
  status: InvestigationStatus,
  statuses: InvestigationStatus[] = ["created", status],
  id = "0f3dbf27-7ee6-4d17-bcbc-b0f64e9c46b1",
  options: { analysisEvidence?: Investigation["analysisEvidence"] } = {}
): Investigation {
  return {
    id,
    request: validRequest,
    status,
    timeline: statuses.map((timelineStatus, index) => ({
      status: timelineStatus,
      at: `2026-07-18T12:00:0${index}.000Z`,
      message: `${timelineStatus} message`
    })),
    hypothesis: {
      summary: "Mock hypothesis",
      confidence: "medium",
      relevantFiles: [{ path: "src/checkout.tsx", reason: "Checkout implementation" }],
      reproductionSteps: ["Open checkout."],
      expectedFailureSignal: "Expected signal.",
      assumptions: []
    },
    generatedTestPath: "tests/checkout.spec.ts",
    verdictExplanation: "The deterministic mock runner returned the expected reproduction signal.",
    recommendedNextStep: "Review the generated test.",
    createdAt: "2026-07-18T12:00:00.000Z",
    updatedAt: "2026-07-18T12:00:00.000Z",
    ...("analysisEvidence" in options ? { analysisEvidence: options.analysisEvidence } : {})
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}
