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

  it("renders complete structured execution evidence without exposing raw execution data", async () => {
    const sensitiveCommand = "npx playwright test --secret-command";
    const sensitiveStdout = "raw runner stdout secret";
    const sensitiveStderr = "raw runner stderr secret";
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        testTitle: "checkout displays validation",
        testStatus: "timedOut",
        assertionFailureMessage: "Expected validation message to be visible.",
        expectedValue: "Validation message",
        actualValue: "No message",
        failureLocation: { file: "tests/checkout.spec.ts", line: 24, column: 9 },
        consoleErrors: ["Checkout request failed.", "Validation state was empty."],
        pageErrors: ["Unhandled page error.", "Second page error."],
        artifactPaths: ["test-results/trace.zip", "test-results/screenshot.png"]
      },
      execution: {
        command: sensitiveCommand,
        exitCode: 1,
        timedOut: true,
        stdout: sensitiveStdout,
        stderr: sensitiveStderr,
        durationMs: 1_000,
        artifacts: ["raw-artifact-path"]
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    expect(within(evidence).getByText(/execution facts, not the final verification verdict/i)).toBeTruthy();
    expect(within(evidence).getByText("checkout displays validation")).toBeTruthy();
    expect(within(evidence).getByText("timed out")).toBeTruthy();
    expect(within(evidence).getByText("Expected validation message to be visible.")).toBeTruthy();
    expect(within(evidence).getByText("Expected validation message to be visible.").classList.contains("execution-evidence-message")).toBe(true);
    expect(within(evidence).getByText("Validation message")).toBeTruthy();
    expect(within(evidence).getByText("No message")).toBeTruthy();
    expect(within(evidence).getByText("tests/checkout.spec.ts", { selector: "code" })).toBeTruthy();
    expect(within(evidence).getByText(/:24:9/)).toBeTruthy();
    const consoleErrors = within(evidence).getByRole("list", { name: "Console errors" });
    expect(within(consoleErrors).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Checkout request failed.",
      "Validation state was empty."
    ]);
    const pageErrors = within(evidence).getByRole("list", { name: "Page errors" });
    expect(within(pageErrors).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Unhandled page error.",
      "Second page error."
    ]);
    expect(within(evidence).getAllByText("test-results/trace.zip", { selector: "code" })).toHaveLength(1);
    expect(within(evidence).getAllByText("test-results/screenshot.png", { selector: "code" })).toHaveLength(1);
    expect(screen.queryByText(sensitiveCommand)).toBeNull();
    expect(screen.queryByText(sensitiveStdout)).toBeNull();
    expect(screen.queryByText(sensitiveStderr)).toBeNull();
    expect(screen.queryByText("raw-artifact-path")).toBeNull();
    expect(within(evidence).queryByRole("link")).toBeNull();
    expect(within(evidence).queryByText("Verified reproduction")).toBeNull();
  });

  it("renders partial execution evidence without empty fields or lists", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        failureLocation: { file: "tests/checkout.spec.ts" },
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: []
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    expect(within(evidence).getByText("tests/checkout.spec.ts", { selector: "code" })).toBeTruthy();
    expect(within(evidence).queryByText("Test title")).toBeNull();
    expect(within(evidence).queryByRole("list", { name: "Console errors" })).toBeNull();
    expect(within(evidence).queryByRole("list", { name: "Page errors" })).toBeNull();
    expect(within(evidence).queryByRole("list", { name: "Artifact paths" })).toBeNull();
  });

  it.each([
    ["a POSIX absolute path", "/private/failspec/worktree/tests/checkout.spec.ts"],
    ["a Windows absolute path", "C:\\Users\\hassan\\worktree\\trace.zip"],
    ["a traversal path", "test-results\\..\\secret.zip"]
  ])("suppresses %s from the failure location", async (_description, unsafePath) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        testTitle: "checkout validation remains observable",
        failureLocation: { file: unsafePath },
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: []
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    expect(within(evidence).getByText("checkout validation remains observable")).toBeTruthy();
    expect(within(evidence).queryByText("Failure location")).toBeNull();
    expect(screen.queryByText(unsafePath)).toBeNull();
  });

  it("renders only safe relative artifact paths", async () => {
    const posixPath = "/private/failspec/worktree/trace.zip";
    const windowsPath = "C:\\Users\\hassan\\worktree\\trace.zip";
    const traversalPath = "test-results/../../secret.zip";
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: ["test-results/trace.zip", posixPath, windowsPath, traversalPath]
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    const artifacts = within(evidence).getByRole("list", { name: "Artifact paths" });
    expect(within(artifacts).getByText("test-results/trace.zip", { selector: "code" })).toBeTruthy();
    expect(screen.queryByText(posixPath)).toBeNull();
    expect(screen.queryByText(windowsPath)).toBeNull();
    expect(screen.queryByText(traversalPath)).toBeNull();
    expect(within(artifacts).queryByRole("link")).toBeNull();
  });

  it("suppresses a file URI from the failure location while preserving other evidence", async () => {
    const fileUri = "file:///private/failspec/worktree/tests/checkout.spec.ts";
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        testTitle: "checkout validation remains observable",
        failureLocation: { file: fileUri },
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: []
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    expect(within(evidence).getByText("checkout validation remains observable")).toBeTruthy();
    expect(within(evidence).queryByText("Failure location")).toBeNull();
    expect(screen.queryByText(fileUri)).toBeNull();
  });

  it("renders only safe relative paths from a mixed URI artifact list", async () => {
    const fileUri = "file:///private/failspec/worktree/trace.zip";
    const windowsFileUri = "file://C:/Users/hassan/worktree/trace.zip";
    const httpsUri = "https://example.com/trace.zip";
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: ["test-results/trace.zip", fileUri, windowsFileUri, httpsUri]
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    const artifacts = within(evidence).getByRole("list", { name: "Artifact paths" });
    expect(within(artifacts).getByText("test-results/trace.zip", { selector: "code" })).toBeTruthy();
    expect(screen.queryByText(fileUri)).toBeNull();
    expect(screen.queryByText(windowsFileUri)).toBeNull();
    expect(screen.queryByText(httpsUri)).toBeNull();
    expect(within(artifacts).queryByRole("link")).toBeNull();
  });

  it("uses the execution-evidence fallback when only file URI paths are supplied", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        failureLocation: { file: "file:///private/failspec/worktree/tests/checkout.spec.ts" },
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: ["file:///private/failspec/worktree/trace.zip"]
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    expect(within(evidence).getByText("No structured execution evidence was recorded for this investigation.")).toBeTruthy();
    expect(evidence.querySelector("dl")).toBeNull();
    expect(within(evidence).queryByRole("list", { name: "Artifact paths" })).toBeNull();
  });

  it("uses the execution-evidence fallback when only unsafe paths are supplied", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        failureLocation: { file: "/private/failspec/worktree/tests/checkout.spec.ts" },
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: ["C:\\Users\\hassan\\worktree\\trace.zip", "../secret.zip"]
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    expect(within(evidence).getByText("No structured execution evidence was recorded for this investigation.")).toBeTruthy();
    expect(evidence.querySelector("dl")).toBeNull();
    expect(within(evidence).queryByRole("list", { name: "Artifact paths" })).toBeNull();
  });

  it("renders console-only execution evidence without an empty definition list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      executionEvidence: {
        consoleErrors: ["Checkout request failed."],
        pageErrors: [],
        artifactPaths: []
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    const consoleErrors = within(evidence).getByRole("list", { name: "Console errors" });
    expect(within(consoleErrors).getByRole("listitem").textContent).toBe("Checkout request failed.");
    expect(evidence.querySelector("dl")).toBeNull();
  });

  it.each([
    ["omits", {}],
    ["contains only empty arrays in", {
      executionEvidence: { consoleErrors: [], pageErrors: [], artifactPaths: [] }
    }]
  ])("shows the execution-evidence fallback when the investigation %s executionEvidence", async (_description, options) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, options)));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    expect(within(evidence).getByText("No structured execution evidence was recorded for this investigation.")).toBeTruthy();
  });

  it("renders preserved execution evidence for an execution error separately from analysis evidence", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("execution_error", undefined, undefined, {
      analysisEvidence: [{ sourcePath: "src/checkout.tsx", observation: "The validation state is missing." }],
      executionEvidence: {
        testStatus: "failed",
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: []
      }
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    expect(await screen.findByRole("region", { name: "Analysis evidence" })).toBeTruthy();
    const evidence = await screen.findByRole("region", { name: "Execution evidence" });
    expect(screen.getByText(/Execution failure:/)).toBeTruthy();
    expect(within(evidence).getByText("failed")).toBeTruthy();
  });

  it.each([
    ["verified", "Verified"],
    ["partial", "Partial evidence"],
    ["not_reproduced", "Not reproduced"],
    ["execution_error", "Execution error"]
  ] as const)("renders the structured %s verification verdict", async (verdict, label) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation(
      verdict,
      undefined,
      undefined,
      { verification: makeVerification({ verdict }) }
    )));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const verification = await screen.findByRole("region", { name: "Verification result" });
    expect(within(verification).getByText(label)).toBeTruthy();
    expect(within(verification).getByText("Classifier explanation.")).toBeTruthy();
    expect(within(verification).getByText("Review the classified evidence.")).toBeTruthy();
    expect(within(verification).queryByText("The deterministic mock runner returned the expected reproduction signal.")).toBeNull();
  });

  it("renders ordered, duplicate, and unknown supporting signals without changing their messages", async () => {
    const signals = [
      { type: "test_status", message: "failed" },
      { type: "console_error", message: "The validation state was empty." },
      { type: "console_error", message: "The validation state was empty." },
      { type: "artifact_path", message: "test-results/trace.zip" },
      { type: "failure_location", message: "tests/checkout.spec.ts:42" },
      { type: "custom_classifier_signal", message: "<classifier signal>" }
    ];
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      verification: makeVerification({ supportingSignals: signals })
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const verification = await screen.findByRole("region", { name: "Verification result" });
    const supportingSignals = within(verification).getByRole("list", { name: "Supporting signals" });
    expect(within(supportingSignals).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Test status: failed",
      "Console error: The validation state was empty.",
      "Console error: The validation state was empty.",
      "Artifact path: test-results/trace.zip",
      "Failure location: tests/checkout.spec.ts:42",
      "Custom classifier signal: <classifier signal>"
    ]);
    expect(within(supportingSignals).getByText("test-results/trace.zip", { selector: "code" })).toBeTruthy();
    expect(within(supportingSignals).getByText("tests/checkout.spec.ts:42", { selector: "code" })).toBeTruthy();
    expect(within(supportingSignals).queryByRole("link")).toBeNull();
    expect(within(verification).queryByRole("img")).toBeNull();
  });

  it("shows the structured-verification signal fallback without an empty list", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      verification: makeVerification({ supportingSignals: [] })
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const verification = await screen.findByRole("region", { name: "Verification result" });
    expect(within(verification).getByText("No additional supporting signals were recorded.")).toBeTruthy();
    expect(within(verification).queryByRole("list", { name: "Supporting signals" })).toBeNull();
  });

  it("renders the deterministic mock verified result", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      verification: makeVerification({
        explanation: "The deterministic mock runner returned the expected reproduction signal.",
        recommendedNextStep: "Review the generated regression test before running it against a real repository.",
        supportingSignals: [{ type: "mock_verification", message: "Deterministic mock verification completed." }]
      })
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const verification = await screen.findByRole("region", { name: "Verification result" });
    expect(within(verification).getByText("Verified")).toBeTruthy();
    expect(within(verification).getByText("Deterministic mock verification completed.")).toBeTruthy();
  });

  it("keeps classified and operational execution errors distinct", async () => {
    const classified = makeInvestigation("execution_error", undefined, "classified-error", {
      verification: makeVerification({
        verdict: "execution_error",
        explanation: "The evidence could not be classified as a valid reproduction.",
        recommendedNextStep: "Inspect the collected evidence."
      })
    });
    const operational = makeInvestigation("execution_error", undefined, "operational-error", {
      verdictExplanation: "The investigation workflow could not complete safely.",
      recommendedNextStep: "Try the investigation again.",
      verification: undefined
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(classified))
      .mockResolvedValueOnce(jsonResponse(operational));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const classifiedSection = await screen.findByRole("region", { name: "Verification result" });
    expect(screen.getByText("Terminal status:")).toBeTruthy();
    expect(within(classifiedSection).getByText("Execution error")).toBeTruthy();
    expect(within(classifiedSection).getByText("Inspect the collected evidence.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start another investigation" }));
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    expect(await screen.findByText("The investigation workflow could not complete safely.")).toBeTruthy();
    expect(screen.getByText("Execution failure:")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Verification result" })).toBeNull();
    expect(screen.queryByText("No additional supporting signals were recorded.")).toBeNull();
  });

  it("keeps legacy records renderable when structured verification and legacy fields are absent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      verification: undefined,
      verdictExplanation: undefined,
      recommendedNextStep: undefined
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    await screen.findByText("Mock hypothesis");
    expect(screen.queryByRole("region", { name: "Verification result" })).toBeNull();
    expect(screen.queryByText(/^Verdict:/)).toBeNull();
    expect(screen.queryByText(/^Next step:/)).toBeNull();
  });

  it("keeps analysis, execution, and verification evidence in separate labelled sections", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("verified", undefined, undefined, {
      analysisEvidence: [{ sourcePath: "src/checkout.tsx", observation: "The validation state is missing." }],
      executionEvidence: {
        consoleErrors: ["Checkout request failed."],
        pageErrors: [],
        artifactPaths: []
      },
      verification: makeVerification({
        supportingSignals: [{ type: "test_status", message: "failed" }]
      })
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const analysis = await screen.findByRole("region", { name: "Analysis evidence" });
    const execution = screen.getByRole("region", { name: "Execution evidence" });
    const verification = screen.getByRole("region", { name: "Verification result" });
    expect(within(analysis).getByRole("listitem").textContent).toContain("The validation state is missing.");
    expect(within(execution).getByText("Checkout request failed.")).toBeTruthy();
    expect(within(execution).queryByText("failed")).toBeNull();
    expect(within(verification).getByRole("listitem").textContent).toBe("Test status: failed");
    expect(within(verification).queryByText("Checkout request failed.")).toBeNull();
    expect(within(verification).queryByText("The validation state is missing.")).toBeNull();
  });

  it("does not infer a verified result from execution facts when structured verification disagrees", async () => {
    const rawCommand = "npx playwright test tests/checkout.spec.ts --reporter=json";
    fetchMock.mockResolvedValueOnce(jsonResponse(makeInvestigation("not_reproduced", undefined, undefined, {
      execution: {
        command: rawCommand,
        exitCode: 1,
        timedOut: false,
        stdout: "sensitive stdout",
        stderr: "sensitive stderr",
        durationMs: 100,
        artifacts: ["raw-artifact-path"]
      },
      executionEvidence: {
        testStatus: "failed",
        consoleErrors: [],
        pageErrors: [],
        artifactPaths: []
      },
      verification: makeVerification({ verdict: "not_reproduced" })
    })));
    render(<App />);
    fillRequiredFields(validRequest);
    fireEvent.click(screen.getByRole("button", { name: "Start investigation" }));

    const verification = await screen.findByRole("region", { name: "Verification result" });
    expect(within(verification).getByText("Not reproduced")).toBeTruthy();
    expect(within(verification).queryByText("Verified")).toBeNull();
    expect(screen.queryByText(rawCommand)).toBeNull();
    expect(screen.queryByText("sensitive stdout")).toBeNull();
    expect(screen.queryByText("sensitive stderr")).toBeNull();
    expect(screen.queryByText("raw-artifact-path")).toBeNull();
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
  options: {
    analysisEvidence?: Investigation["analysisEvidence"];
    executionEvidence?: Investigation["executionEvidence"];
    execution?: Investigation["execution"];
    verification?: Investigation["verification"];
    verdictExplanation?: Investigation["verdictExplanation"];
    recommendedNextStep?: Investigation["recommendedNextStep"];
  } = {}
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
    ...("analysisEvidence" in options ? { analysisEvidence: options.analysisEvidence } : {}),
    ...("executionEvidence" in options ? { executionEvidence: options.executionEvidence } : {}),
    ...("execution" in options ? { execution: options.execution } : {}),
    ...("verification" in options ? { verification: options.verification } : {}),
    ...("verdictExplanation" in options ? { verdictExplanation: options.verdictExplanation } : {}),
    ...("recommendedNextStep" in options ? { recommendedNextStep: options.recommendedNextStep } : {})
  };
}

function makeVerification(
  overrides: Partial<NonNullable<Investigation["verification"]>> = {}
): NonNullable<Investigation["verification"]> {
  return {
    verdict: "verified",
    explanation: "Classifier explanation.",
    recommendedNextStep: "Review the classified evidence.",
    supportingSignals: [{ type: "mock_verification", message: "Deterministic mock verification completed." }],
    ...overrides
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
