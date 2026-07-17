import { extractCodexAgentMessage } from "./jsonl.js";

export interface CodexCliResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexCliExecutor {
  execute(input: { cwd: string; prompt: string }): Promise<CodexCliResponse>;
}

export class CodexJsonlClient {
  constructor(private readonly executor: CodexCliExecutor) {}

  async run(input: { cwd: string; prompt: string }): Promise<string> {
    const response = await this.executor.execute(input);

    if (response.exitCode !== 0) {
      throw new Error(response.stderr || "Codex CLI failed");
    }

    return extractCodexAgentMessage(response.stdout);
  }
}
