import type { InvestigationRequest, ReproductionHypothesis } from "@failspec/contracts";
import { generatedTestPolicyDescription, generatedTestPolicyExample } from "../generated-test/index.js";

const repositoryTestContext = `The repository path is a preflighted isolated worktree. Derive the Playwright config, test directory, start command, base URL, and existing Playwright test examples by read-only inspection. Do not invent values that are not present in the repository.`;

export function buildAnalysisPrompt(request: InvestigationRequest): string {
  return `You are investigating one reported failure in a trusted local React or Next.js repository.

Rules:
- Inspect repository files in read-only mode.
- Do not modify production code.
- Do not claim the bug is reproduced. Test execution and verdict classification happen elsewhere.

Repository-test context:
${repositoryTestContext}

Bug report:
${JSON.stringify(request, null, 2)}

Return only JSON with this shape:
{
  "hypothesis": {
    "summary": "string",
    "confidence": "low | medium | high",
    "relevantFiles": [{ "path": "string", "reason": "string" }],
    "reproductionSteps": ["string"],
    "expectedFailureSignal": "string",
    "assumptions": ["string"]
  },
  "evidence": [{ "sourcePath": "string", "observation": "string" }]
}`;
}

export function buildTestGenerationPrompt(
  request: InvestigationRequest,
  hypothesis: ReproductionHypothesis
): string {
  return `You are writing one Playwright regression test for a trusted local React or Next.js repository.

Rules:
- Inspect repository files in read-only mode.
- Do not modify production code.
- Reuse selectors, routes, and behavioral expectations from the repository only when they are compatible with this policy.
- This policy overrides incompatible repository helpers, custom fixtures, variables, aliases, page objects, and conventions.
- Generate exactly one minimal Playwright regression test.
- Do not claim the bug is reproduced. Test execution and verdict classification happen elsewhere.
${generatedTestPolicyDescription}
- Follow this canonical shape exactly. Replace only the title, literal selectors, literal values, and allowed direct calls needed for the repository. Do not add variables, helpers, aliases, extra imports, or unsupported call options:

\`\`\`ts
${generatedTestPolicyExample}
\`\`\`

Repository-test context:
${repositoryTestContext}

Bug report:
${JSON.stringify(request, null, 2)}

Hypothesis:
${JSON.stringify(hypothesis, null, 2)}

Return only JSON with this shape:
{
  "generatedTestContent": "string"
}`;
}
