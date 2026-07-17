import { spawn } from "node:child_process";
import type { CodexCliExecutor, CodexCliResponse } from "./client.js";

export function createLocalCodexCliExecutor(command = "codex"): CodexCliExecutor {
  return {
    execute({ cwd, prompt }) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const child = spawn(
          command,
          ["exec", "--json", "--sandbox", "read-only", "--ephemeral", prompt],
          { cwd, stdio: ["ignore", "pipe", "pipe"] }
        );

        const finish = (response: CodexCliResponse) => {
          if (!settled) {
            settled = true;
            resolve(response);
          }
        };

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("error", (error: Error) => {
          finish({ exitCode: 1, stdout, stderr: stderr || error.message });
        });
        child.on("close", (code: number | null) => {
          finish({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    }
  };
}
