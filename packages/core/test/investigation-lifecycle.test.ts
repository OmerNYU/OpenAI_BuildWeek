import { describe, expect, it } from "vitest";
import { assertTransition, canTransition, isTerminalStatus } from "../src/investigation-lifecycle.js";

describe("investigation lifecycle", () => {
  it("allows the sequential lifecycle", () => {
    expect(canTransition("created", "preflight")).toBe(true);
    expect(canTransition("preflight", "analyzing")).toBe(true);
    expect(canTransition("analyzing", "hypothesis_ready")).toBe(true);
    expect(canTransition("hypothesis_ready", "generating_test")).toBe(true);
    expect(canTransition("generating_test", "test_ready")).toBe(true);
    expect(canTransition("test_ready", "executing")).toBe(true);
    expect(canTransition("executing", "verified")).toBe(true);
  });

  it("rejects invalid transitions and identifies terminal statuses", () => {
    expect(() => assertTransition("created", "executing")).toThrow("Invalid investigation transition");
    expect(isTerminalStatus("verified")).toBe(true);
    expect(isTerminalStatus("executing")).toBe(false);
  });

  it("allows execution errors from runtime stages", () => {
    expect(canTransition("preflight", "execution_error")).toBe(true);
    expect(canTransition("analyzing", "execution_error")).toBe(true);
    expect(canTransition("generating_test", "execution_error")).toBe(true);
    expect(canTransition("executing", "execution_error")).toBe(true);
  });
});
