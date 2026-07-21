# FailSpec

From vague failures to verified tests.

FailSpec is a local-first developer tool that turns a reported failure in a trusted local React or Next.js repository into an evidence-backed Playwright regression-test result.

## Prerequisites

- Node.js 20 or newer
- npm

## Installation

```powershell
npm install
```

## Workspaces

- `apps/web`: React and Vite application shell.
- `apps/server`: Express API scaffold.
- `packages/contracts`: shared TypeScript types and Zod schemas.
- `packages/core`: investigation lifecycle and typed mock adapter boundaries.

See [the Codex investigation workflow](docs/codex-workflow.md) for the real Codex adapter boundary and generated-test rules.

## Development

```powershell
npm run dev:web
npm run dev:server
```

### Codex mode

Mock mode is the default and does not require a Codex installation:

```powershell
$env:FAILSPEC_CODEX_MODE = "mock"
npm run dev:server
```

Local mode requires an installed and authenticated Codex CLI:

```powershell
$env:FAILSPEC_CODEX_MODE = "local"
npm run dev:server
```

Mock mode uses pass-through repository preparation: it performs no Git commands or preflight checks and uses the submitted repository path directly. Local mode runs repository preflight, prepares an isolated workspace, stages and runs the generated test, persists sanitized execution facts and structured execution evidence, and cleans up the workspace before invoking the deterministic verification classifier. The complete `VerificationResult` is persisted, while legacy explanation and next-step fields remain for compatibility. Mock mode injects a deterministic verified classifier without real repository, staging, or execution work. A classified `execution_error` is distinct from a safe workflow error; real local verified reproduction remains unavailable under the current affirmative-evidence policy. Classifier-generated path signals are made display-safe at the classifier boundary before `VerificationResult` is returned. Unsafe `failure_location` and `artifact_path` signals are suppressed by the classifier, while safe relative paths remain unchanged and ordered. Investigation orchestration validates and persists the classifier result without filtering or reinterpreting its supporting signals; no ad hoc server-side supporting-signal or path filtering exists. PR #53 is merged and is no longer a dependency.

## Investigation API

The backend schedules investigation workflows in-process. Mock mode remains deterministic, while local mode uses the real Codex, staging, and controlled-runner boundaries:

- `POST /api/investigations`
- `GET /api/investigations/:id`

Create an investigation with:

```json
{
  "repositoryPath": "C:\\projects\\sample-app",
  "bugTitle": "Checkout button does not complete purchase",
  "bugDescription": "Submitting checkout leaves the user on the same page.",
  "expectedBehavior": "The confirmation page should appear.",
  "actualBehavior": "The page remains on checkout.",
  "terminalLog": "Mock console output"
}
```

`POST /api/investigations` returns the persisted initial `created` investigation. Clients retrieve progress through `GET /api/investigations/:id` until a terminal result includes the ordered timeline, deterministic hypothesis, generated test, execution result, verdict explanation, and recommended next step. Runtime records are stored as one JSON file per investigation under `.failspec/investigations/`. Scheduled work is not durable across server restarts; the MVP has no production job queue or recovery mechanism.

## Verification

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

## Current scaffold limitations

The frontend supports bug-report submission, investigation progress, polling through the existing API, and terminal summaries. The real Codex adapter is integrated behind `FAILSPEC_CODEX_MODE=local` and performs repository preflight plus analysis and test generation in an isolated worktree. Local orchestration stages the generated test, runs it through the controlled Playwright runner, persists sanitized execution facts and execution evidence separately, cleans up the workspace, and then invokes verification classification. Cleanup is in-process only and uses the existing worktree boundary; cleanup failure prevents a successful result. Verification outcomes come from the classifier rather than inference from Playwright status or an exit code. Mock mode remains deterministic and performs no real repository, staging, runner, or process work.
