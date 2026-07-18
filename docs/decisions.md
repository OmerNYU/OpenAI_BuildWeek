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
- **Decision:** Support React or Next.js repositories, Playwright regression tests, and one generated regression test per investigation.
- **Context:** Keep the hackathon MVP narrowly scoped.
- **Alternatives considered:** Broader frameworks, languages, or multiple generated tests.
- **Rationale:** Focus implementation and verification on the approved workflow.
- **Consequences:** Broader support remains pending.
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

### Mock investigation orchestration

- **Date:** 2026-07-17
- **Decision:** Run synchronous deterministic mock orchestration for the initial backend vertical slice.
- **Context:** Return a polling-ready terminal record without queues or simulated background work.
- **Alternatives considered:** Background jobs, timers, and asynchronous scheduling.
- **Rationale:** Keep the first integration path deterministic and straightforward to test.
- **Consequences:** The create endpoint may complete the mock workflow before returning.
- **Owners:** Person 1

### Execution and verification boundary

- **Date:** 2026-07-18
- **Decision:** `RunnerAdapter` returns `RunnerOutput`, which contains backward-compatible `ExecutionResult` command facts and separate `ExecutionEvidence`. Verification alone assigns final outcomes through `VerificationResult`.
- **Context:** Preserve raw Playwright facts without treating a failed process or test as proof of reproduction.
- **Alternatives considered:** Require generated tests to use named `test.step()` labels, or infer a verdict from the process exit code.
- **Rationale:** Playwright status, assertion details, errors, and artifacts provide evidence without constraining generated-test structure. A non-zero exit code is insufficient by itself.
- **Consequences:** Runner implementations record facts only. Implementations must sanitize any failure message before it is public or persisted. Preflight, worktree, and staging operations use typed result unions.
- **Owners:** Persons 1, 2, and 3
