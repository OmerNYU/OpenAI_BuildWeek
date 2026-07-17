import type { InvestigationRequest } from "@failspec/contracts";

export function buildInvestigationPrompt(request: InvestigationRequest): string {
  return `You are investigating one reported failure in a trusted local React or Next.js repository.

Rules:
- Inspect repository files in read-only mode.
- Do not modify production code.
- Reuse the repository's existing Playwright conventions.
- Generate exactly one minimal Playwright regression test.
- Do not claim the bug is reproduced. Test execution and verdict classification happen elsewhere.

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
  "evidence": [{ "sourcePath": "string", "observation": "string" }],
  "generatedTestContent": "string"
}`;
}
