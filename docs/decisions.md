# Architecture decision log

Record only decisions confirmed by the team. Do not add speculative or unapproved decisions.

## Entry template

### [Decision title]

- **Date:** YYYY-MM-DD
- **Decision:**
- **Context:**
- **Alternatives considered:**
- **Rationale:**
- **Consequences:**
- **Owners:**

### Local-first product

- **Date:** 2026-07-17
- **Decision:** FailSpec runs locally against trusted local repositories; the hackathon MVP is not a hosted SaaS.
- **Context:** Define the product boundary for the MVP.
- **Alternatives considered:** Hosted SaaS operation.
- **Rationale:** Preserve local-first operation and the trusted-repository boundary.
- **Consequences:** Hosting and SaaS infrastructure are out of scope for the MVP.
- **Owners:** Person 1

### Supported MVP

- **Date:** 2026-07-17
- **Decision:** Support npm-based Next.js and Vite React repositories, Playwright regression tests, and one generated regression test per investigation.
- **Context:** Keep the hackathon MVP narrowly scoped.
- **Alternatives considered:** Broader frameworks, languages, or multiple generated tests.
- **Rationale:** Focus implementation and verification on the approved workflow.
- **Consequences:** Create React App, Remix, Gatsby, Parcel, custom Webpack or Node startup servers, and other React toolchains are out of scope for the MVP. Next requires `next`, `react`, `react-dom`, and `"dev": "next dev"`; Vite React requires `vite`, `react`, `react-dom`, and `"dev": "vite"`. Both require npm, `package-lock.json`, existing Playwright configuration, and the approved generated-test script. Command strings, wrappers, shell chaining, and arbitrary script contents are rejected.
- **Owners:** Persons 1, 2, and 3

### Runner-compatible Playwright configuration

- **Date:** 2026-07-19
- **Decision:** Supported MVP Playwright configurations must use `FAILSPEC_BASE_URL` and disable their own `webServer` when `FAILSPEC_MANAGED_SERVER=1`.
- **Context:** The controlled runner owns dynamic loopback port allocation, startup, readiness, and process cleanup.
- **Alternatives considered:** Fixed fixture ports, repository-owned Playwright web servers, and runner-generated configuration files.
- **Rationale:** A small explicit configuration convention preserves repository tests while allowing deterministic runner ownership during generated-test execution.
- **Consequences:** Preflight rejects configurations without both markers. Without runner variables, the fixture retains its standalone Playwright behavior.
- **Owners:** Persons 1, 2, and 3

### Verification outcomes

- **Date:** 2026-07-17
- **Decision:** Supported final outcomes are Verified reproduction, Partial reproduction, Not reproduced, and Execution error. A failed command, failed test, or non-zero exit code is insufficient by itself to prove reproduction.
- **Context:** Define evidence-backed verification.
- **Alternatives considered:** Treating any failed execution as proof.
- **Rationale:** Separate execution failure from verified reproduction.
- **Consequences:** Results require classification and supporting evidence.
- **Owners:** Person 3

### Parallel development

- **Date:** 2026-07-17
- **Decision:** Unavailable workstream modules must be represented using shared typed contracts and deterministic typed mocks.
- **Context:** Allow parallel work before every module is available.
- **Alternatives considered:** Untyped placeholders or speculative integrations.
- **Rationale:** Preserve integration stability and contract clarity.
- **Consequences:** Adapters remain behind typed boundaries until real modules are available.
- **Owners:** Person 1

### Git workflow

- **Date:** 2026-07-17
- **Decision:** No direct work on `main`; changes reach `main` only through reviewed pull requests; required verification must pass before merge; merge strategy is squash-and-merge.
- **Context:** Establish the shared repository workflow.
- **Alternatives considered:** Direct pushes or other merge strategies.
- **Rationale:** Keep changes reviewed and verification-gated.
- **Consequences:** Branches and pull requests are required for changes to `main`.
- **Owners:** All contributors

### Platform scaffold tooling

- **Date:** 2026-07-17
- **Decision:** Use npm workspaces with React and Vite for the frontend, Express for the backend, Vitest for unit tests, Supertest for server routes, Testing Library for web tests, and no monorepo orchestration framework.
- **Context:** Establish the approved Milestone 0 platform scaffold.
- **Alternatives considered:** Turborepo, Nx, alternate frontend/backend tools, and separate test stacks.
- **Rationale:** Provide a small, familiar toolchain with direct workspace support.
- **Consequences:** Build ordering is handled by root npm scripts; Turborepo and Nx are out of scope.
- **Owners:** Person 1

### Initial platform integration

- **Date:** 2026-07-17
- **Decision:** Use polling for initial progress updates and local JSON persistence behind a storage boundary.
- **Context:** Enable the first local vertical slice without hosted infrastructure.
- **Alternatives considered:** SSE, a database, and direct persistence coupling.
- **Rationale:** Keep initial integration local, deterministic, and replaceable.
- **Consequences:** Storage and progress transport can be evolved behind their boundaries later.
- **Owners:** Person 1

### Mock investigation persistence

- **Date:** 2026-07-17
- **Decision:** Store one JSON file per investigation and write it through a temporary file followed by rename.
- **Context:** Persist the initial local backend vertical slice without a database.
- **Alternatives considered:** A single shared file, direct writes, and a database.
- **Rationale:** Keep records isolated and reduce exposure to partially written JSON.
- **Consequences:** Local filesystem storage remains behind a typed store boundary.
- **Owners:** Person 1

### In-process investigation orchestration

- **Date:** 2026-07-19
- **Decision:** Schedule deterministic mock investigation workflows in-process after persisting the initial `created` record.
- **Context:** Allow the frontend to observe an investigation progressing through polling without adding a production queue.
- **Alternatives considered:** Synchronous workflow execution, a durable job queue, and external background infrastructure.
- **Rationale:** An injected in-process scheduler preserves a small local MVP while making progress observable and tests deterministic.
- **Consequences:** `POST` returns the persisted initial state and clients poll `GET` for progress. Scheduled work is not durable across server restarts, and no recovery mechanism exists.
- **Owners:** Person 1

### Isolated repository orchestration

- **Date:** 2026-07-19
- **Decision:** Local Codex and runner operations use a detached FailSpec-owned worktree after repository preflight; mock mode uses an injected pass-through workspace implementation.
- **Context:** Keep local investigation operations isolated from submitted source repositories while preserving the deterministic mock workflow.
- **Alternatives considered:** Operate directly in the submitted repository or require a real Git repository in mock mode.
- **Rationale:** Preflight and a detached owned worktree keep local operations within Person 3's repository-safety boundary, while pass-through mode keeps the mock API usable for arbitrary test paths.
- **Consequences:** From successful preparation through cleanup, each worktree is exclusively owned by its investigation: FailSpec components do not mutate it concurrently; Codex is read-only; staging completes before generated code or an application/browser process launches; and cleanup is required before successful terminal completion. On POSIX, staging enforces a root owned by the current user with no group or other permissions. Deliberate concurrent mutation by an external process under the same OS user remains outside the MVP threat model, so staging is bounded validation rather than a sandbox. Cleanup is not durable or recoverable across server restarts. Generated-test staging and real Playwright execution remain deferred.
- **Owners:** Persons 1 and 3

### Execution and verification boundary

- **Date:** 2026-07-18
- **Decision:** `RunnerAdapter` returns `RunnerOutput`, which contains backward-compatible `ExecutionResult` command facts and separate `ExecutionEvidence`. Verification alone assigns final outcomes through `VerificationResult`.
- **Context:** Preserve raw Playwright facts without treating a failed process or test as proof of reproduction.
- **Alternatives considered:** Require generated tests to use named `test.step()` labels, or infer a verdict from the process exit code.
- **Rationale:** Playwright status, assertion details, errors, and artifacts provide evidence without constraining generated-test structure. A non-zero exit code is insufficient by itself.
- **Consequences:** Runner implementations record facts only. Execution-evidence schemas validate evidence structure and limit individual message fields, but do not sanitize collected content; the real runner must sanitize it before constructing `RunnerOutput`. Preflight, worktree, and staging contracts expose stable failure codes only.
- **Owners:** Persons 1, 2, and 3
