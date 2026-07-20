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

Mock mode uses pass-through repository preparation: it performs no Git commands or preflight checks and uses the submitted repository path directly. Local mode runs repository preflight and consumes the existing deterministic isolated-worktree boundary. Codex analysis, test generation, and the mocked runner boundary receive the prepared workspace path; cleanup uses that same existing boundary. The submitted repository path remains persisted with the investigation.

Generated-test staging and controlled Playwright execution are implemented as Person 3 boundaries, but orchestration still injects the deterministic mock runner until the separate integration work lands. Verdict classification remains mocked.

## Investigation API

The backend schedules deterministic mock orchestration in-process for the first vertical slice:

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

The frontend supports bug-report submission, investigation progress, polling through the existing API, and terminal summaries. The real Codex adapter is integrated behind `FAILSPEC_CODEX_MODE=local` and performs repository preflight plus analysis and test generation in an isolated worktree. Cleanup is in-process only and uses the existing worktree boundary; cleanup failure prevents successful verification. Generated-test staging, controlled Playwright execution, and execution-evidence collection are implemented boundaries, but orchestration still uses its deterministic mock runner and verdict classifier until the separate integration work lands.
