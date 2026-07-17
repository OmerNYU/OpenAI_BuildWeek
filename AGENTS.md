# FailSpec contributor guidance

## Purpose and MVP

FailSpec is a local-first developer tool that turns a reported failure in a trusted local React or Next.js repository into an evidence-backed Playwright regression-test result. The MVP supports only trusted local React or Next.js repositories, Playwright regression tests, and local-first operation.

## Ownership and boundaries

- Person 1 owns root configuration, shared contracts, core orchestration, backend API, investigation state and persistence, app shell, intake, progress delivery, CI, and cross-workstream integration.
- Person 2 owns Codex repository investigation, reproduction hypotheses, structured model output, and Playwright test generation.
- Person 3 owns repository preflight, Git worktrees, controlled test execution, verification classification, execution evidence, result UI, and fixture repositories.

Integrate workstreams through shared typed contracts and typed mocks. Do not redesign or take ownership of another member’s workstream without an approved shared decision. Announce and review shared contract changes with affected owners. Keep execution, Codex, and verification integrations behind typed contracts; do not broaden framework, language, or hosting support without an approved decision.

## Git and working rules

Inspect the repository, current branch, `origin`, and working-tree state before editing. Never work directly on `main`; switch to an approved feature branch first. Do not push or merge directly to `main`, bypass branch protection, or force-push without explicit approval. Do not commit or push unless explicitly requested.

## Verification and evidence

Run relevant linting, typechecking, tests, and build checks before calling work complete. Preserve failed-command and failed-test evidence. A generated test or non-zero command exit is not, by itself, proof of a verified reproduction.

## Definition of done

Completed work is scoped to the approved issue, integrated through typed contracts, documented where needed, and verified with the relevant checks and evidence recorded. Update the local internal build record after every completed implementation task.

## Out of scope

Do not add automatic bug fixing, pull-request generation, GitHub OAuth, authentication, team accounts, hosted SaaS infrastructure, broad framework/language support, custom model training, long-term model memory, a general-purpose debugging chatbot, or unrestricted execution of unknown repositories.
