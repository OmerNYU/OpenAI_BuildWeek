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

const boundedTextSchema = nonEmptyString.max(2_000);

export const playwrightTestStatusSchema = z.enum([
  "passed",
  "failed",
  "skipped",
  "timedOut",
  "interrupted",
  "unknown"
]);
export type PlaywrightTestStatus = z.infer<typeof playwrightTestStatusSchema>;

export const executionEvidenceSchema = z.object({
  testTitle: nonEmptyString.optional(),
  testStatus: playwrightTestStatusSchema.optional(),
  assertionFailureMessage: boundedTextSchema.optional(),
  expectedValue: z.string().max(2_000).optional(),
  actualValue: z.string().max(2_000).optional(),
  failureLocation: z
    .object({
      file: nonEmptyString,
      line: z.number().int().positive().optional(),
      column: z.number().int().positive().optional()
    })
    .optional(),
  consoleErrors: z.array(boundedTextSchema),
  pageErrors: z.array(boundedTextSchema),
  artifactPaths: z.array(nonEmptyString)
});
export type ExecutionEvidence = z.infer<typeof executionEvidenceSchema>;

export const runnerOutputSchema = z.object({
  execution: executionResultSchema,
  evidence: executionEvidenceSchema
});
export type RunnerOutput = z.infer<typeof runnerOutputSchema>;

export const repositoryPreflightFailureCodeSchema = z.enum([
  "unsafe_path",
  "not_git_repository",
  "dirty_repository",
  "unsupported_framework",
  "playwright_not_configured",
  "unsupported_package_manager",
  "unsupported_script",
  "inspection_failed"
]);
export type RepositoryPreflightFailureCode = z.infer<typeof repositoryPreflightFailureCodeSchema>;

const preflightFailureSchema = z.object({ code: repositoryPreflightFailureCodeSchema }).strict();

export const repositoryPreflightResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready"), repositoryPath: nonEmptyString }),
  z.object({ status: z.literal("unsupported"), failure: preflightFailureSchema }),
  z.object({ status: z.literal("failed"), failure: preflightFailureSchema })
]);
export type RepositoryPreflightResult = z.infer<typeof repositoryPreflightResultSchema>;

export const worktreeFailureCodeSchema = z.enum([
  "invalid_destination",
  "creation_failed",
  "metadata_failed",
  "cleanup_failed"
]);
export type WorktreeFailureCode = z.infer<typeof worktreeFailureCodeSchema>;

const worktreeFailureSchema = z.object({ code: worktreeFailureCodeSchema }).strict();

export const worktreePreparationResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("prepared"),
    investigationId: nonEmptyString,
    sourceRepositoryPath: nonEmptyString,
    worktreePath: nonEmptyString
  }),
  z.object({ status: z.literal("failed"), failure: worktreeFailureSchema })
]);
export type WorktreePreparationResult = z.infer<typeof worktreePreparationResultSchema>;

export const generatedTestStagingFailureCodeSchema = z.enum([
  "invalid_encoding",
  "file_too_large",
  "typescript_parse_failed",
  "disallowed_import",
  "disallowed_api",
  "write_failed"
]);
export type GeneratedTestStagingFailureCode = z.infer<
  typeof generatedTestStagingFailureCodeSchema
>;

const stagingFailureSchema = z.object({ code: generatedTestStagingFailureCodeSchema }).strict();

export const generatedTestStagingResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("staged"), stagedTestPath: nonEmptyString }),
  z.object({ status: z.literal("rejected"), failure: stagingFailureSchema }),
  z.object({ status: z.literal("failed"), failure: stagingFailureSchema })
]);
export type GeneratedTestStagingResult = z.infer<typeof generatedTestStagingResultSchema>;

export const verificationVerdictSchema = z.enum([
  "verified",
  "partial",
  "not_reproduced",
  "execution_error"
]);
export type VerificationVerdict = z.infer<typeof verificationVerdictSchema>;

export const verificationSignalSchema = z.object({
  type: nonEmptyString,
  message: boundedTextSchema
});
export type VerificationSignal = z.infer<typeof verificationSignalSchema>;

export const verificationResultSchema = z.object({
  verdict: verificationVerdictSchema,
  explanation: boundedTextSchema,
  recommendedNextStep: boundedTextSchema,
  supportingSignals: z.array(verificationSignalSchema)
});
export type VerificationResult = z.infer<typeof verificationResultSchema>;

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
