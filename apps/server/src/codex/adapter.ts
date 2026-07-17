import type { CodexAdapter, GenerateTestInput, GeneratedTest } from "@failspec/core";
import type { InvestigationRequest, ReproductionHypothesis } from "@failspec/contracts";
import { CodexJsonlClient } from "./client.js";
import { parseCodexAnalysisOutput, parseCodexGeneratedTestOutput } from "./output.js";
import { validateGeneratedPlaywrightTest } from "./playwright-test.js";
import { buildAnalysisPrompt, buildTestGenerationPrompt } from "./prompt.js";

class InvalidCodexOutputError extends Error {}

export class CodexInvestigationAdapter implements CodexAdapter {
  constructor(private readonly client: CodexJsonlClient) {}

  async analyze(request: InvestigationRequest): Promise<ReproductionHypothesis> {
    const output = await this.runOnce(request.repositoryPath, buildAnalysisPrompt(request), (response) =>
      parseCodexAnalysisOutput(JSON.parse(response))
    );

    return output.hypothesis;
  }

  async generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
    const output = await this.runWithOneRetry(
      input.request,
      buildTestGenerationPrompt(input.request, input.hypothesis),
      (response) => {
        const generated = parseCodexGeneratedTestOutput(JSON.parse(response));
        const validation = validateGeneratedPlaywrightTest(generated.generatedTestContent);

        if (!validation.valid) {
          throw new Error(validation.errors.join("; "));
        }

        return generated;
      }
    );

    return { content: output.generatedTestContent };
  }

  private async runWithOneRetry<T>(
    request: InvestigationRequest,
    prompt: string,
    parse: (response: string) => T
  ): Promise<T> {
    try {
      return await this.runOnce(request.repositoryPath, prompt, parse);
    } catch (error) {
      if (!(error instanceof InvalidCodexOutputError)) {
        throw error;
      }

      return this.runOnce(
        request.repositoryPath,
        `${prompt}\n\nYour previous response was invalid: ${error.message}\nReturn corrected JSON only.`,
        parse
      );
    }
  }

  private async runOnce<T>(
    repositoryPath: string,
    prompt: string,
    parse: (response: string) => T
  ): Promise<T> {
    const response = await this.client.run({ cwd: repositoryPath, prompt });

    try {
      return parse(response);
    } catch (error) {
      throw new InvalidCodexOutputError(
        error instanceof Error ? error.message : "Codex returned invalid JSON"
      );
    }
  }
}
