# Codex Investigation Workflow

FailSpec converts a bug report for one trusted local React or Next.js repository into one executable Playwright regression test. The Codex module investigates and writes the test. It does not modify production code, run arbitrary commands, or decide the final verification verdict.

## Boundaries

- Supported target: one prepared React or Next.js repository with Playwright already configured.
- Repository inspection is read-only.
- Generated output is written only to the workspace path supplied by the runner.
- One generated Playwright test is allowed for each investigation.
- One correction request is allowed only when the generated test is structurally invalid.
- A failing command is evidence, not a verdict. Person 3 owns execution and verdict classification.

## Inputs

The module accepts the shared `InvestigationRequest`, preflight information, and a repository context object from the runner.

```ts
interface CodexRepositoryContext {
  repositoryPath: string;
  generatedTestPath: string;
  playwrightConfigPath: string;
  testDirectory: string;
  packageManager: "npm" | "pnpm" | "yarn";
  startCommand: string;
  baseUrl: string;
  existingTests: Array<{ path: string; content: string }>;
}
```

The runner provides this context only after it confirms the repository is trusted, Playwright is configured, and the isolated workspace is writable.

## Outputs

Codex returns a response that validates against the shared hypothesis schema and includes the generated test.

```ts
interface CodexInvestigationOutput {
  hypothesis: ReproductionHypothesis;
  generatedTestContent: string;
  evidence: Array<{
    sourcePath: string;
    observation: string;
  }>;
}
```

`evidence.sourcePath` must be a file identified in `hypothesis.relevantFiles`. The generated test is persisted at `generatedTestPath` only after validation succeeds.

## State flow

```text
preflight → analyzing → hypothesis_ready → generating_test → test_ready → executing
```

Person 2 owns the `analyzing`, `hypothesis_ready`, `generating_test`, and `test_ready` work. Person 1 persists the state and exposes it to the UI. Person 3 owns `executing` and the final statuses: `verified`, `partial`, `not_reproduced`, and `execution_error`.

## Investigation procedure

1. Read the bug title, description, expected behavior, actual behavior, logs, and screenshot path.
2. Read only the approved repository files, including Playwright configuration and relevant existing tests.
3. Identify the observable symptom. Do not claim a root cause unless the inspected evidence supports it.
4. Return a hypothesis with relevant files, reasons, assumptions, minimal reproduction steps, confidence, and one expected failure signal.
5. Use the existing Playwright tests as the style and selector authority.
6. Produce one minimal test that exercises the stated symptom and contains no production-code changes.
7. Validate the output schema and test structure before writing the test file.

## Structural validation and retry

A test is structurally invalid only when one of these checks fails:

- The output is not valid TypeScript text.
- It does not contain a Playwright `test(...)` declaration.
- It imports unsupported packages or omits `@playwright/test`.
- It writes outside the supplied test path.
- It has no user interaction or assertion tied to the stated failure signal.

On the first structural failure, send Codex the validation errors, original bug report, repository context, and prior test. Request one complete replacement. If the replacement is invalid, return a typed malformed-output error. Do not retry because a valid test fails to reproduce the bug.

## Error handling

| Failure | Module result | Investigation state |
| --- | --- | --- |
| Codex authentication unavailable | `codex_authentication_error` | `execution_error` |
| Model unavailable | `codex_model_error` | `execution_error` |
| Invalid structured response | `codex_malformed_output` | `execution_error` |
| Valid test, later runner failure | preserve test and evidence | determined by Person 3 |

The first implementation chooses one proven transport, either the Codex SDK or controlled local Codex CLI. It preserves the same module interface for the mock and real path, but does not add a provider abstraction without both implementations.

## Team handoff

- Person 1 provides validated request data, state transitions, persistence, and progress events.
- Person 2 returns validated investigation output and writes the generated test to the supplied path.
- Person 3 provides repository preflight, existing-test context, safe workspace paths, execution evidence, and final verdicts.
