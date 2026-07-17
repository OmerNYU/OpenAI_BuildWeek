---
name: failspec
description: Investigate a reported failure in a trusted local React or Next.js repository and generate one validated Playwright regression test. Use when FailSpec needs repository analysis, a reproduction hypothesis, or a single test from a bug report.
---

# FailSpec investigation

Use this workflow only in a trusted, preflighted isolated worktree. Inspect the repository read-only and return structured content. Do not modify source files, write a test file, execute Playwright, or classify the verdict.

## Investigate

1. Read the bug title, description, expected behavior, actual behavior, and any logs or screenshot path.
2. Inspect the relevant implementation, `package.json`, Playwright configuration, and existing Playwright tests.
3. Derive the test directory, application start command, base URL, and test conventions from repository files. Do not invent missing values.
4. Return only this JSON shape:

```json
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
}
```

Make every evidence `sourcePath` match a `relevantFiles.path`. State uncertainty in `assumptions`. Do not claim the failure is reproduced.

## Generate the test

Use the accepted hypothesis and the repository's existing Playwright conventions. Return only:

```json
{ "generatedTestContent": "string" }
```

The content must be valid TypeScript and must:

- import `test` and `expect` from `@playwright/test`;
- declare exactly one non-shadowed Playwright `test()` call;
- include a user interaction and an assertion;
- test the reported behavior without changing production code.

If the generated-test response is malformed or structurally invalid, return corrected JSON once. If that corrected generated-test response is still invalid, stop and return the validation error. Do not retry analysis output or CLI failures.

## Handoff

Return the hypothesis and generated test content to the orchestrator. The runner owns writing the test into the worktree, executing it, preserving execution output and artifacts, and classifying the result as verified, partial, not reproduced, or an execution error.
