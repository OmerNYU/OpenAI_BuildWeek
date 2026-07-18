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

Local mode performs real read-only repository analysis and test generation through Codex. Runner execution and verdict classification remain mocked; no real Playwright test is executed.

## Investigation API

The backend currently provides synchronous deterministic mock orchestration for the first vertical slice:

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

The mock response reaches `verified` and includes an ordered timeline, deterministic hypothesis, generated test, execution result, verdict explanation, and recommended next step. Runtime records are stored as one JSON file per investigation under `.failspec/investigations/`.

## Verification

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

## Current scaffold limitations

The frontend supports bug-report submission, investigation progress, polling through the existing API, and terminal summaries. The current mock backend may complete an investigation synchronously. The real Codex adapter is integrated behind `FAILSPEC_CODEX_MODE=local` and performs real Codex analysis and test generation. Repository preflight, isolated worktrees, generated-test staging, real Playwright execution, evidence propagation, and evidence-based verdict classification remain incomplete; runner execution and the final verdict remain mocked.
