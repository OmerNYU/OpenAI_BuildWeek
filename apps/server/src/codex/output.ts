import {
  reproductionHypothesisSchema,
  type ReproductionHypothesis
} from "@failspec/contracts";
import { z } from "zod";

const evidenceSchema = z.object({
  sourcePath: z.string().trim().min(1),
  observation: z.string().trim().min(1)
});

export const codexInvestigationOutputSchema = z
  .object({
    hypothesis: reproductionHypothesisSchema,
    evidence: z.array(evidenceSchema),
    generatedTestContent: z.string().refine((content) => content.trim().length > 0, {
      message: "Generated test content must not be empty"
    })
  })
  .superRefine((output, context) => {
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
  });

export interface CodexInvestigationOutput {
  hypothesis: ReproductionHypothesis;
  evidence: Array<z.infer<typeof evidenceSchema>>;
  generatedTestContent: string;
}

export function parseCodexInvestigationOutput(input: unknown): CodexInvestigationOutput {
  return codexInvestigationOutputSchema.parse(input);
}
