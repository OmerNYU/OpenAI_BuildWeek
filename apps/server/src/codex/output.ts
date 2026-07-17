import {
  reproductionHypothesisSchema,
  type ReproductionHypothesis
} from "@failspec/contracts";
import { z } from "zod";

const evidenceSchema = z.object({
  sourcePath: z.string().trim().min(1),
  observation: z.string().trim().min(1)
});

const analysisOutputSchema = z.object({
  hypothesis: reproductionHypothesisSchema,
  evidence: z.array(evidenceSchema)
});

function validateEvidence(
  output: z.infer<typeof analysisOutputSchema>,
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

export const codexAnalysisOutputSchema = analysisOutputSchema.superRefine(validateEvidence);
export const codexGeneratedTestOutputSchema = generatedTestOutputSchema;
export const codexInvestigationOutputSchema = analysisOutputSchema
  .extend(generatedTestOutputSchema.shape)
  .superRefine(validateEvidence);

export interface CodexInvestigationOutput {
  hypothesis: ReproductionHypothesis;
  evidence: Array<z.infer<typeof evidenceSchema>>;
  generatedTestContent: string;
}

export interface CodexAnalysisOutput {
  hypothesis: ReproductionHypothesis;
  evidence: Array<z.infer<typeof evidenceSchema>>;
}

export interface CodexGeneratedTestOutput {
  generatedTestContent: string;
}

export function parseCodexAnalysisOutput(input: unknown): CodexAnalysisOutput {
  return codexAnalysisOutputSchema.parse(input);
}

export function parseCodexGeneratedTestOutput(input: unknown): CodexGeneratedTestOutput {
  return codexGeneratedTestOutputSchema.parse(input);
}

export function parseCodexInvestigationOutput(input: unknown): CodexInvestigationOutput {
  return codexInvestigationOutputSchema.parse(input);
}
