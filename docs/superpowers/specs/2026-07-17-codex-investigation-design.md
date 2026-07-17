# Codex Investigation Design

## Goal

Provide FailSpec with a bounded Codex workflow that turns a bug report into an evidence-backed hypothesis and one minimal Playwright regression test for the prepared demo repository.

## Recommended approach

Use a single proven local Codex transport behind a small module API. The module receives normalized request and repository context from the server, inspects only approved files, validates structured output, and writes one test into a runner-provided workspace.

This is preferred over a multi-agent or multi-provider design because the hackathon only needs one model, one fixture, and one test. A mock and real implementation may share an interface. No general provider layer is needed.

## Alternatives considered

1. Use a custom agent framework with tool orchestration. Rejected because it duplicates Codex capabilities and adds failure modes.
2. Let Codex directly run the repository and decide success. Rejected because it blurs the safe runner boundary and treats test failure as a verdict.
3. Use one bounded Codex invocation with supplied repository evidence and one structural retry. Chosen because it is the smallest workflow that proves the product value.

## Components

| Component | Responsibility | Owner |
| --- | --- | --- |
| `apps/server/src/codex/` | Codex transport, prompts, parsing, validation, test writing | Person 2 |
| `packages/contracts/src/hypothesis.ts` | Shared hypothesis schema | Person 2 with Person 1 approval |
| `apps/server/src/investigations/` | State persistence and API orchestration | Person 1 |
| `apps/server/src/repository/` | Preflight and repository context | Person 3 |
| `apps/server/src/runner/` | Test execution and artifacts | Person 3 |
| `apps/server/src/verification/` | Verdict classification | Person 3 |

## Data flow

1. Person 1 accepts an `InvestigationRequest` and creates an investigation.
2. Person 3 preflights the repository and produces `CodexRepositoryContext`.
3. Person 2 generates and validates `CodexInvestigationOutput`.
4. Person 2 writes the test into the isolated workspace.
5. Person 3 executes it and returns `ExecutionResult`.
6. Person 3 classifies the result without relying on exit code alone.

## Constraints

- Trusted local React or Next.js repositories with Playwright only.
- Read-only inspection and no production-code edits.
- One generated test and at most one structural repair attempt.
- Never use a failed command as proof of a verified reproduction.
- Preserve evidence and generated artifacts for the result interface.

## Decisions needing team confirmation

- The exact progress event names and error envelope from Person 1.
- The repository context fields and generated-test path from Person 3.
- Whether the shared schema is authored in `packages/contracts` or defined there and re-exported from the Person 2 module.
- The chosen local Codex transport after the connectivity spike.
