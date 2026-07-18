import {
  codexAnalysisResultSchema,
  type CodexAnalysisResult
} from "@failspec/contracts";
import { z } from "zod";

function validateEvidence(
  output: CodexAnalysisResult,
  context: z.RefinementCtx
) {
    const relevantPaths = new Set(output.hypothesis.relevantFiles.map((file) => file.path));

    for (const evidence of output.evidence) {
      if (!relevantPaths.has(evidence.sourcePath)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Evidence source path must be a relevant file",
          path: ["evidence"]
        });
      }
    }
}

const generatedTestOutputSchema = z.object({
  generatedTestContent: z.string().refine((content) => content.trim().length > 0, {
    message: "Generated test content must not be empty"
  })
});

export const codexAnalysisOutputSchema = codexAnalysisResultSchema.superRefine(validateEvidence);
export const codexGeneratedTestOutputSchema = generatedTestOutputSchema;

export type CodexAnalysisOutput = CodexAnalysisResult;

export interface CodexGeneratedTestOutput {
  generatedTestContent: string;
}

export function parseCodexAnalysisOutput(input: unknown): CodexAnalysisOutput {
  return codexAnalysisOutputSchema.parse(input);
}

export function parseCodexGeneratedTestOutput(input: unknown): CodexGeneratedTestOutput {
  return codexGeneratedTestOutputSchema.parse(input);
}
