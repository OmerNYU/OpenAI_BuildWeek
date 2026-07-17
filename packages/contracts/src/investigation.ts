import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const investigationRequestSchema = z.object({
  repositoryPath: nonEmptyString,
  bugTitle: nonEmptyString,
  bugDescription: nonEmptyString,
  expectedBehavior: nonEmptyString,
  actualBehavior: nonEmptyString,
  terminalLog: z.string().optional(),
  screenshotPath: z.string().optional()
});

export type InvestigationRequest = z.infer<typeof investigationRequestSchema>;

export const investigationStatuses = [
  "created",
  "preflight",
  "analyzing",
  "hypothesis_ready",
  "generating_test",
  "test_ready",
  "executing",
  "verified",
  "partial",
  "not_reproduced",
  "execution_error"
] as const;

export const investigationStatusSchema = z.enum(investigationStatuses);
export type InvestigationStatus = z.infer<typeof investigationStatusSchema>;

export const terminalInvestigationStatuses = [
  "verified",
  "partial",
  "not_reproduced",
  "execution_error"
] as const;

export const reproductionHypothesisSchema = z.object({
  summary: nonEmptyString,
  confidence: z.enum(["low", "medium", "high"]),
  relevantFiles: z.array(z.object({ path: nonEmptyString, reason: nonEmptyString })),
  reproductionSteps: z.array(nonEmptyString),
  expectedFailureSignal: nonEmptyString,
  assumptions: z.array(nonEmptyString)
});
export type ReproductionHypothesis = z.infer<typeof reproductionHypothesisSchema>;

export const executionResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  artifacts: z.array(z.string())
});
export type ExecutionResult = z.infer<typeof executionResultSchema>;

export const investigationTimelineEventSchema = z.object({
  status: investigationStatusSchema,
  at: z.string().datetime(),
  message: nonEmptyString
});
export type InvestigationTimelineEvent = z.infer<typeof investigationTimelineEventSchema>;

export const investigationResultSchema = z.object({
  id: nonEmptyString,
  status: investigationStatusSchema,
  hypothesis: reproductionHypothesisSchema.optional(),
  generatedTestPath: z.string().optional(),
  generatedTestContent: z.string().optional(),
  execution: executionResultSchema.optional(),
  verdictExplanation: z.string().optional(),
  recommendedNextStep: z.string().optional()
});
export type InvestigationResult = z.infer<typeof investigationResultSchema>;

export const investigationSchema = investigationResultSchema.extend({
  request: investigationRequestSchema,
  timeline: z.array(investigationTimelineEventSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});
export type Investigation = z.infer<typeof investigationSchema>;

export const apiErrorResponseSchema = z.object({
  error: z.string(),
  details: z.unknown().optional()
});
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
