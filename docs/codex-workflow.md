# Codex investigation workflow

FailSpec uses Codex to inspect a trusted local React or Next.js repository and propose one Playwright regression test. Codex never decides whether a bug was reproduced.

## Setup and boundary

Authenticate the local Codex CLI before using the real adapter. The adapter invokes `codex exec` in JSONL mode with a read-only sandbox and an ephemeral session. Default mock mode uses pass-through repository preparation and performs no Git operations. Local mode runs repository preflight against the submitted source path and consumes the existing deterministic isolated-worktree boundary. The submitted path remains persisted with the investigation, while Codex inspection, generated-test staging, and controlled runner execution use the prepared workspace path. Cleanup uses the existing worktree boundary. Codex inspection remains read-only.

The local executor stops a Codex process after 120 seconds or after 1 MiB of combined standard output and error output. It returns a CLI failure to the caller. The adapter does not pin a model, so model selection follows the local Codex CLI configuration.

The server uses `MockCodexAdapter` by default. Set `FAILSPEC_CODEX_MODE=local` to use `CodexInvestigationAdapter`; this requires an installed and authenticated Codex CLI. In local mode, `CodexInvestigationAdapter.analyze()` receives a derived request whose repository path is the isolated worktree, and `generateTest()` receives that same derived request. In local mode, the generated test is staged and executed through the controlled Playwright runner, and its sanitized execution facts and structured evidence are persisted. Verification classification remains unavailable, so local investigations end fail-closed as `execution_error` after evidence collection. Mock mode retains deterministic mock execution and verification.

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

Codex and generated-test staging use one shared, fail-closed policy. Generated content must use the exact unaliased `expect` and `test` imports from `@playwright/test`, declare one async test with the approved `page` and optional `request` fixtures, and contain only awaited direct calls from the approved Playwright surface. It must include an interaction and assertion. Navigation and request targets are restricted to relative paths or loopback HTTP(S) URLs. Locator text assertions may use `toContainText`.

The policy is a static allowlist, not a runtime sandbox. Controlled execution remains responsible for process and network containment. The adapter makes one correction attempt only for malformed JSON, schema failures, or failed shared-policy validation. If that corrected response is still invalid, the workflow stops with the validation error. It does not retry a failed Codex CLI process.

## Stop rules

- Stop without retry when analysis JSON or schema validation fails.
- Stop when the Codex CLI exits unsuccessfully, including its 120-second timeout or 1 MiB output-limit failure.
- Stop when the repository cannot supply the required test context without invention.
- Stop when the second generated-test response remains invalid after the one allowed correction.

## Handoff and verdict

The orchestrator moves the investigation from `hypothesis_ready` to `generating_test`, stages the generated test through the approved boundary, and transitions to `test_ready` only after staging succeeds. In local mode it then uses the controlled Playwright runner and persists its sanitized execution facts separately from execution evidence. Verification classification remains deferred: local execution terminates fail-closed as `execution_error` after evidence collection, because a test failure, a passing test, or a non-zero exit code alone is not proof of reproduction. Mock mode retains its deterministic mock result without invoking real staging or runner operations. A cleanup failure prevents successful completion. Analysis evidence remains separate and cannot establish reproduction.

The supported verdicts are verified reproduction, partial reproduction, not reproduced, and execution error.
