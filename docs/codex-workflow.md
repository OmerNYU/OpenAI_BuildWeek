# Codex investigation workflow

FailSpec uses Codex to inspect a trusted local React or Next.js repository and propose one Playwright regression test. Codex never decides whether a bug was reproduced.

## Setup and boundary

Authenticate the local Codex CLI before using the real adapter. The adapter invokes `codex exec` in JSONL mode with a read-only sandbox and an ephemeral session. Default mock mode uses deterministic pass-through repository preparation and performs no Git operations. Local mode runs repository preflight against the submitted source path, creates a detached FailSpec-owned worktree, and keeps the submitted path in the persisted investigation record. Codex inspection remains read-only. Cleanup removes metadata-only partial failures and Git-recognized worktrees through Git; an existing destination that Git does not recognize is preserved with its metadata for later recovery.

The local executor stops a Codex process after 120 seconds or after 1 MiB of combined standard output and error output. It returns a CLI failure to the caller. The adapter does not pin a model, so model selection follows the local Codex CLI configuration.

The server uses `MockCodexAdapter` by default. Set `FAILSPEC_CODEX_MODE=local` to use `CodexInvestigationAdapter`; this requires an installed and authenticated Codex CLI. In local mode, `CodexInvestigationAdapter.analyze()` receives a derived request whose repository path is the isolated worktree, and `generateTest()` receives that same derived request. Runner execution and verdict classification remain mocked. No real Playwright test is executed by this integration.

## Investigation

During `analyzing`, Codex receives the bug report and performs read-only inspection in the isolated worktree. It derives the Playwright configuration, test directory, application start command, base URL, and existing test conventions from that repository snapshot. It must not invent missing repository context.

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

The validated analysis evidence is stored with the hypothesis and returned by the existing investigation API. The results UI may display this persisted evidence separately. Analysis evidence does not go to the runner and cannot establish a verdict.

## Test generation

During `generating_test`, Codex receives the same isolated-worktree request and accepted hypothesis. It returns only:

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

The orchestrator moves the investigation from `hypothesis_ready` to `generating_test` and then `test_ready`. The runner boundary receives the isolated worktree path, but the currently injected runner is deterministic and mocked. Generated-test staging and real Playwright execution are not implemented. Execution evidence and evidence-based verdict classification remain deferred. A cleanup failure prevents successful verification. Analysis evidence remains separate and cannot establish reproduction; a test failure or non-zero command alone is not proof of reproduction.

The supported verdicts are verified reproduction, partial reproduction, not reproduced, and execution error.
