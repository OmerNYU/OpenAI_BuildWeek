import type { CodexAdapter, GenerateTestInput, GeneratedTest } from "@failspec/core";
import type { CodexAnalysisResult, CodexFailureCategory, InvestigationRequest } from "@failspec/contracts";
import { CodexJsonlClient } from "./client.js";
import { CodexFailure } from "./failure.js";
import { parseCodexAnalysisOutput, parseCodexGeneratedTestOutput } from "./output.js";
import { validateGeneratedPlaywrightTest } from "./playwright-test.js";
import { buildAnalysisPrompt, buildTestGenerationPrompt } from "./prompt.js";

export class CodexInvestigationAdapter implements CodexAdapter {
  constructor(private readonly client: CodexJsonlClient) {}

  async analyze(request: InvestigationRequest): Promise<CodexAnalysisResult> {
    const output = await this.runWithOneRetry(
      request,
      buildAnalysisPrompt(request),
      "invalid_analysis_output",
      (response) => parseCodexAnalysisOutput(JSON.parse(response))
    );

    return output;
  }

  async generateTest(input: GenerateTestInput): Promise<GeneratedTest> {
    const output = await this.runWithOneRetry(
      input.request,
      buildTestGenerationPrompt(input.request, input.hypothesis),
      "invalid_generated_test_output",
      (response) => {
        const generated = parseCodexGeneratedTestOutput(JSON.parse(response));
        const validation = validateGeneratedPlaywrightTest(generated.generatedTestContent);

        if (!validation.valid) {
          throw new CodexFailure("invalid_generated_test_output");
        }

        return generated;
      }
    );

    return { content: output.generatedTestContent };
  }

  private async runWithOneRetry<T>(
    request: InvestigationRequest,
    prompt: string,
    invalidOutputCategory: CodexFailureCategory,
    parse: (response: string) => T
  ): Promise<T> {
    try {
      return await this.runOnce(request.repositoryPath, prompt, invalidOutputCategory, parse);
    } catch (error) {
      if (!(error instanceof CodexFailure) || error.category !== invalidOutputCategory) {
        throw error;
      }

      return this.runOnce(
        request.repositoryPath,
        `${prompt}\n\nYour previous response did not match the required contract. Return corrected JSON only.`,
        invalidOutputCategory,
        parse
      );
    }
  }

  private async runOnce<T>(
    repositoryPath: string,
    prompt: string,
    invalidOutputCategory: CodexFailureCategory,
    parse: (response: string) => T
  ): Promise<T> {
    let response: string;
    try {
      response = await this.client.run({ cwd: repositoryPath, prompt });
    } catch (error) {
      if (error instanceof CodexFailure) {
        throw error;
      }
      throw new CodexFailure(invalidOutputCategory);
    }

    try {
      return parse(response);
    } catch {
      throw new CodexFailure(invalidOutputCategory);
    }
  }
}
