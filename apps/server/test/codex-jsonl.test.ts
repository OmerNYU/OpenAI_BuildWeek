import { describe, expect, it } from "vitest";
import { extractCodexAgentMessage } from "../src/codex/jsonl.js";

describe("extractCodexAgentMessage", () => {
  it("returns the final agent message from Codex JSONL output", () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"thread-1"}',
      '{"type":"item.completed","item":{"type":"error","message":"warning"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}',
      '{"type":"turn.completed"}'
    ].join("\n");

    expect(extractCodexAgentMessage(stdout)).toBe('{"ok":true}');
  });

  it("rejects output that has no completed agent message", () => {
    expect(() => extractCodexAgentMessage('{"type":"turn.completed"}')).toThrow(
      "Codex did not return an agent message"
    );
  });
});
