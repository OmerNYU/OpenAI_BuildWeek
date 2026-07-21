import { describe, expect, it } from "vitest";
import { CodexJsonlClient } from "../src/codex/client.js";

describe("CodexJsonlClient", () => {
  it("returns the final agent message from a successful CLI response", async () => {
    const client = new CodexJsonlClient({
      async execute() {
        return {
          exitCode: 0,
          stdout:
            '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"ok\\":true}"}}',
          stderr: ""
        };
      }
    });

    await expect(client.run({ cwd: "/tmp/example", prompt: "Return JSON." })).resolves.toBe(
      '{"ok":true}'
    );
  });

  it("returns a safe failure category when the CLI exits unsuccessfully", async () => {
    const client = new CodexJsonlClient({
      async execute() {
        return { exitCode: 1, stdout: "", stderr: "Authentication failed" };
      }
    });

    await expect(client.run({ cwd: "/tmp/example", prompt: "Return JSON." })).rejects.toThrow("cli_failed");
  });
});
