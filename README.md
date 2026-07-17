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

## Development

```powershell
npm run dev:web
npm run dev:server
```

## Verification

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

## Current scaffold limitations

The scaffold does not yet implement investigation submission, progress polling, persistence, or results. Real Codex and Playwright execution are not implemented.
