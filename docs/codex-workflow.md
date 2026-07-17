# Codex investigation workflow

FailSpec uses Codex to inspect a trusted local React or Next.js repository and propose one Playwright regression test. Codex never decides whether a bug was reproduced.

## Setup and boundary

Authenticate the local Codex CLI before using the real adapter. The adapter invokes `codex exec` in JSONL mode with a read-only sandbox and an ephemeral session. It runs from the repository path supplied by preflight, which must be an isolated worktree.

The local executor stops a Codex process after 120 seconds or after 1 MiB of combined standard output and error output. It returns a CLI failure to the caller. The adapter does not pin a model, so model selection follows the local Codex CLI configuration.

The server still uses `MockCodexAdapter` by default. `CodexInvestigationAdapter` is the real implementation for the integration path.

## Investigation

During `analyzing`, Codex receives the bug report and performs read-only inspection. It derives the Playwright configuration, test directory, application start command, base URL, and existing test conventions from the repository. It must not invent missing repository context.

Codex returns JSON with a reproduction hypothesis and file-backed evidence:

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

Zod validates the response. Every evidence path must be one of the hypothesis's relevant files. Invalid analysis output is returned as an error and is not retried.

Current limitation: `CodexInvestigationAdapter.analyze()` returns only the validated hypothesis. Its analysis evidence array is discarded, so it is not propagated through the shared adapter, persisted by the orchestrator, or handed to the runner.

## Test generation

During `generating_test`, Codex receives the request and accepted hypothesis. It returns only:

```json
{ "generatedTestContent": "string" }
```

The generated content must be valid TypeScript, import Playwright's `test`, declare exactly one non-shadowed `test()` call, contain a user interaction, and contain an assertion. The adapter makes one correction attempt only for malformed JSON, schema failures, or failed structural validation. If that corrected response is still invalid, the workflow stops with the validation error. It does not retry a failed Codex CLI process.

## Stop rules

- Stop without retry when analysis JSON or schema validation fails.
- Stop when the Codex CLI exits unsuccessfully, including its 120-second timeout or 1 MiB output-limit failure.
- Stop when the repository cannot supply the required test context without invention.
- Stop when the second generated-test response remains invalid after the one allowed correction.

## Handoff and verdict

The orchestrator moves the investigation from `hypothesis_ready` to `generating_test` and then `test_ready`. Person 3's runner writes the generated test into the worktree, executes Playwright, preserves execution output and artifacts, and classifies the result. It does not receive the discarded analysis evidence. A test failure or non-zero command alone is not proof of reproduction.

The supported verdicts are verified reproduction, partial reproduction, not reproduced, and execution error.
