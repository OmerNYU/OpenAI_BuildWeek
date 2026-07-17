import { describe, expect, it } from "vitest";
import {
  parseCodexAnalysisOutput,
  parseCodexGeneratedTestOutput
} from "../src/codex/output.js";

const validAnalysis = {
  hypothesis: {
    summary: "Checkout does not show the validation error.",
    confidence: "high",
    relevantFiles: [
      {
        path: "src/checkout.tsx",
        reason: "It renders the checkout form."
      }
    ],
    reproductionSteps: ["Open checkout.", "Submit an empty form."],
    expectedFailureSignal: "The required-field message is missing.",
    assumptions: ["The local app starts successfully."]
  },
  evidence: [
    {
      sourcePath: "src/checkout.tsx",
      observation: "The submit handler does not render an error message."
    }
  ]
};

describe("Codex output parsing", () => {
  it("returns validated analysis output", () => {
    expect(parseCodexAnalysisOutput(validAnalysis)).toEqual(validAnalysis);
  });

  it("returns validated generated test output", () => {
    const generatedTest = { generatedTestContent: "test content" };

    expect(parseCodexGeneratedTestOutput(generatedTest)).toEqual(generatedTest);
  });

  it("rejects evidence that does not reference a relevant file", () => {
    expect(() =>
      parseCodexAnalysisOutput({
        ...validAnalysis,
        evidence: [{ sourcePath: "src/unrelated.ts", observation: "Unrelated." }]
      })
    ).toThrow("Evidence source path must be a relevant file");
  });
});
