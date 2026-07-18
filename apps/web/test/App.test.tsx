import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Investigation, InvestigationRequest, InvestigationStatus } from "@failspec/contracts";
import { App } from "../src/App";

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

  it.each<InvestigationStatus>(["verified", "partial", "not_reproduced", "execution_error"])(
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

function makeInvestigation(
  status: InvestigationStatus,
  statuses: InvestigationStatus[] = ["created", status]
): Investigation {
  return {
    id: "0f3dbf27-7ee6-4d17-bcbc-b0f64e9c46b1",
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
    updatedAt: "2026-07-18T12:00:00.000Z"
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
