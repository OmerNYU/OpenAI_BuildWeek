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
