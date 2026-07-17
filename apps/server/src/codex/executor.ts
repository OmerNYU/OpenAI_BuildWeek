import { spawn } from "node:child_process";
import type { CodexCliExecutor, CodexCliResponse } from "./client.js";

const defaultTimeoutMs = 120_000;
const defaultMaxOutputBytes = 1_048_576;

export function createLocalCodexCliExecutor(
  command = "codex",
  timeoutMs = defaultTimeoutMs,
  maxOutputBytes = defaultMaxOutputBytes
): CodexCliExecutor {
  return {
    execute({ cwd, prompt }) {
      return new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let outputBytes = 0;
        let settled = false;
        const child = spawn(
          command,
          ["exec", "--json", "--sandbox", "read-only", "--ephemeral", prompt],
          { cwd, stdio: ["ignore", "pipe", "pipe"] }
        );

        const finish = (response: CodexCliResponse) => {
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            resolve(response);
          }
        };
        const timeout = setTimeout(() => {
          child.kill();
          finish({ exitCode: 1, stdout, stderr: "Codex CLI timed out" });
        }, timeoutMs);
        const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
          const text = chunk.toString();

          if (outputBytes + Buffer.byteLength(text) > maxOutputBytes) {
            child.kill();
            finish({
              exitCode: 1,
              stdout,
              stderr: `Codex CLI output exceeded ${maxOutputBytes} bytes`
            });
            return;
          }

          outputBytes += Buffer.byteLength(text);
          if (stream === "stdout") {
            stdout += text;
          } else {
            stderr += text;
          }
        };

        child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
        child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
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
