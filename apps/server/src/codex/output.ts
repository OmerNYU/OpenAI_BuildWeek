import {
  codexAnalysisResultSchema,
  type CodexAnalysisResult
} from "@failspec/contracts";
import { z } from "zod";

const generatedTestOutputSchema = z.object({
  generatedTestContent: z.string().refine((content) => content.trim().length > 0, {
    message: "Generated test content must not be empty"
  })
});

export const codexAnalysisOutputSchema = codexAnalysisResultSchema;
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
