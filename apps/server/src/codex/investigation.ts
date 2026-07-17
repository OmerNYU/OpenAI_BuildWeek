import type { InvestigationRequest } from "@failspec/contracts";
import { CodexJsonlClient } from "./client.js";
import { parseCodexInvestigationOutput, type CodexInvestigationOutput } from "./output.js";
import { validateGeneratedPlaywrightTest } from "./playwright-test.js";
import { buildInvestigationPrompt } from "./prompt.js";

class InvalidCodexOutputError extends Error {}

export async function runCodexInvestigation(
  client: CodexJsonlClient,
  request: InvestigationRequest
): Promise<CodexInvestigationOutput> {
  const prompt = buildInvestigationPrompt(request);

  try {
    return await runOnce(client, request.repositoryPath, prompt);
  } catch (error) {
    if (!(error instanceof InvalidCodexOutputError)) {
      throw error;
    }

    return runOnce(
      client,
      request.repositoryPath,
      `${prompt}\n\nYour previous response was invalid: ${error.message}\nReturn corrected JSON only.`
    );
  }
}

async function runOnce(
  client: CodexJsonlClient,
  repositoryPath: string,
  prompt: string
): Promise<CodexInvestigationOutput> {
  const response = await client.run({ cwd: repositoryPath, prompt });
  let output: CodexInvestigationOutput;

  try {
    output = parseCodexInvestigationOutput(JSON.parse(response));
  } catch (error) {
    throw new InvalidCodexOutputError(
      error instanceof Error ? error.message : "Codex returned invalid JSON"
    );
  }

  const validation = validateGeneratedPlaywrightTest(output.generatedTestContent);

  if (!validation.valid) {
    throw new InvalidCodexOutputError(validation.errors.join("; "));
  }

  return output;
}
