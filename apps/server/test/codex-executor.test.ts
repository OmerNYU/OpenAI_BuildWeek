import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn }));

import { createLocalCodexCliExecutor } from "../src/codex/executor.js";

function createChildProcess() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return child;
}

describe("createLocalCodexCliExecutor", () => {
  it("runs Codex in read-only ephemeral JSONL mode", async () => {
    const child = createChildProcess();
    spawn.mockReturnValue(child);
    const executor = createLocalCodexCliExecutor();

    const result = executor.execute({ cwd: "/tmp/example", prompt: "Return JSON." });
    child.stdout.emit("data", Buffer.from('{"type":"turn.completed"}\n'));
    child.stderr.emit("data", Buffer.from("warning\n"));
    child.emit("close", 0);

    await expect(result).resolves.toEqual({
      exitCode: 0,
      stdout: '{"type":"turn.completed"}\n',
      stderr: "warning\n"
    });
    expect(spawn).toHaveBeenCalledWith(
      "codex",
      ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "Return JSON."],
      { cwd: "/tmp/example", stdio: ["ignore", "pipe", "pipe"] }
    );
  });

  it("reports a launch error as a failed CLI response", async () => {
    const child = createChildProcess();
    spawn.mockReturnValue(child);
    const executor = createLocalCodexCliExecutor();

    const result = executor.execute({ cwd: "/tmp/example", prompt: "Return JSON." });
    child.emit("error", new Error("codex command not found"));

    await expect(result).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "codex command not found"
    });
  });

  it("terminates Codex when it exceeds the timeout", async () => {
    vi.useFakeTimers();

    try {
      const child = createChildProcess();
      spawn.mockReturnValue(child);
      const executor = createLocalCodexCliExecutor("codex", 10);
      const result = executor.execute({ cwd: "/tmp/example", prompt: "Return JSON." });

      await vi.advanceTimersByTimeAsync(10);

      expect(child.kill).toHaveBeenCalledOnce();
      await expect(result).resolves.toEqual({
        exitCode: 1,
        stdout: "",
        stderr: "Codex CLI timed out"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates Codex when output exceeds the limit", async () => {
    const child = createChildProcess();
    spawn.mockReturnValue(child);
    const executor = createLocalCodexCliExecutor("codex", 120_000, 8);
    const result = executor.execute({ cwd: "/tmp/example", prompt: "Return JSON." });

    child.stdout.emit("data", Buffer.from("too much output"));

    expect(child.kill).toHaveBeenCalledOnce();
    await expect(result).resolves.toEqual({
      exitCode: 1,
      stdout: "",
      stderr: "Codex CLI output exceeded 8 bytes"
    });
  });
});
