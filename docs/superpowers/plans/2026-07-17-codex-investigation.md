# Codex Investigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Deliver a bounded, validated Codex workflow that produces one Playwright regression test for the prepared FailSpec demo repository.

**Architecture:** The Codex module receives a normalized bug report and runner-approved repository context. It returns a validated hypothesis, test content, and evidence. The runner owns filesystem isolation and test execution. The verification module owns the final verdict.

**Tech Stack:** Node.js 20, TypeScript, Zod, local Codex SDK or controlled Codex CLI, Playwright, Vitest.

## Global Constraints

- Support trusted local React or Next.js repositories that already use Playwright.
- Read repository files only. Never edit production code.
- Generate one Playwright test in the runner-provided isolated workspace.
- Permit one retry only for a structurally invalid generated test.
- Reuse the fixture's Playwright configuration and test conventions.
- Use mocked Codex output in CI. Run one real Codex demonstration manually.
- Keep each objective on its own short-lived descriptive branch and merge through a reviewed pull request.
- Commit as `Hassan Raza <hassanraza0406@gmail.com>` with short messages.

## Branch sequence

| Branch | Deliverable | Primary dependency |
| --- | --- | --- |
| `spike/codex-connectivity` | Proven local transport and model evidence | Local Codex authentication |
| `feat/hypothesis-contract` | Approved hypothesis schema | Person 1 |
| `feat/failspec-skill` | Repository-investigation skill | Approved schema |
| `feat/repository-investigation` | Read-only investigation and hypothesis generation | Fixture context from Person 3 |
| `feat/codex-output-validation` | Typed parser and malformed-output errors | Investigation output |
| `feat/playwright-test-generation` | Minimal generated test and evidence | Existing fixture tests |
| `feat/invalid-test-retry` | One structural correction attempt | Structural validator |
| `feat/codex-integration` | Server and runner handoff | Person 1 and Person 3 contracts |
| `fix/codex-demo-reliability` | Evidence-backed demo fixes only | Vertical-slice results |
| `docs/codex-demo-evidence` | Final model usage, limits, and demo evidence | Successful demo |

### Task 1: Prove Codex connectivity

**Branch:** `spike/codex-connectivity`

**Files:**
- Create: `apps/server/src/codex/connectivity.ts`
- Create: `apps/server/src/codex/connectivity.test.ts`
- Create: `docs/decisions.md`

**Interfaces:**

```ts
export interface CodexConnectivityResult {
  authenticated: boolean;
  transport: "sdk" | "cli";
  model: string;
  message: string;
}
```

- [ ] Write a failing test that accepts one successful mocked connectivity response and rejects an unauthenticated response.
- [ ] Implement the smallest probe that uses either the SDK or controlled CLI, not both.
- [ ] Record the transport, exact available model, and fallback decision in `docs/decisions.md`.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Commit with `chore: verify codex connectivity`, request Person 3 review, and merge before dependent work.

### Task 2: Agree and validate the hypothesis contract

**Branch:** `feat/hypothesis-contract`

**Files:**
- Create: `packages/contracts/src/hypothesis.ts`
- Create: `packages/contracts/src/hypothesis.test.ts`
- Modify: `packages/contracts/src/index.ts`

**Interfaces:**

```ts
export interface ReproductionHypothesis {
  summary: string;
  confidence: "low" | "medium" | "high";
  relevantFiles: Array<{ path: string; reason: string }>;
  reproductionSteps: string[];
  expectedFailureSignal: string;
  assumptions: string[];
}
```

- [ ] Ask Person 1 to approve this shared shape before opening the branch.
- [ ] Write schema tests for a complete hypothesis and each required-field failure.
- [ ] Implement the Zod schema and inferred TypeScript type once, then export both from `packages/contracts/src/index.ts`.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Commit with `feat: add hypothesis contract`, obtain Person 3 review plus Person 1 approval, then merge.

### Task 3: Add the FailSpec skill and prompt contract

**Branch:** `feat/failspec-skill`

**Files:**
- Create: `.agents/skills/failspec/SKILL.md`
- Create: `apps/server/src/codex/prompts.ts`
- Create: `apps/server/src/codex/prompts.test.ts`

**Interfaces:**

```ts
export interface CodexRepositoryContext {
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

- [ ] Write a failing prompt test that requires the bug report, repository context, existing tests, read-only rule, one-test limit, evidence requirement, and structural output instructions.
- [ ] Implement a prompt builder with one system instruction and one request payload. Do not introduce prompt classes or a template registry.
- [ ] Write `SKILL.md` with the exact inspection boundary, required output fields, and no-production-edit rule.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Commit with `feat: add investigation skill`, request Person 3 review, then merge.

### Task 4: Implement repository investigation and validated output

**Branch:** `feat/repository-investigation`

**Files:**
- Create: `apps/server/src/codex/investigate.ts`
- Create: `apps/server/src/codex/investigate.test.ts`
- Create: `apps/server/src/codex/errors.ts`

**Interfaces:**

```ts
export interface CodexInvestigationOutput {
  hypothesis: ReproductionHypothesis;
  generatedTestContent: string;
  evidence: Array<{ sourcePath: string; observation: string }>;
}

export type CodexInvestigationError =
  | { code: "codex_authentication_error"; message: string }
  | { code: "codex_model_error"; message: string }
  | { code: "codex_malformed_output"; message: string };
```

- [ ] Write a failing test using a mocked Codex response that returns a valid hypothesis, evidence tied to relevant files, and test content.
- [ ] Write a failing test for invalid JSON, a missing hypothesis field, and evidence with an unrelated source path.
- [ ] Implement the one transport selected by the connectivity spike and validate its response with the shared schema.
- [ ] Return typed errors. Do not convert parser failures into a successful hypothesis.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Commit with `feat: add repository investigation`, request Person 3 review, then merge.

### Task 5: Generate and validate one Playwright test

**Branch:** `feat/playwright-test-generation`

**Files:**
- Create: `apps/server/src/codex/test-generation.ts`
- Create: `apps/server/src/codex/test-generation.test.ts`
- Modify: `apps/server/src/codex/investigate.ts`

**Interfaces:**

```ts
export interface TestValidationResult {
  valid: boolean;
  errors: string[];
}
```

- [ ] Write a failing test for a minimal `@playwright/test` spec that follows the fixture's existing import and test style.
- [ ] Write failing tests for missing `test(...)`, unsupported imports, no assertion, no user interaction, and a test path outside `generatedTestPath`.
- [ ] Implement structural validation with TypeScript text checks. It must inspect content only and must not execute the test.
- [ ] Write validated test content to the exact `generatedTestPath` from repository context.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Commit with `feat: generate playwright test`, request Person 3 review, then merge.

### Task 6: Add the one permitted correction attempt

**Branch:** `feat/invalid-test-retry`

**Files:**
- Modify: `apps/server/src/codex/test-generation.ts`
- Modify: `apps/server/src/codex/test-generation.test.ts`
- Modify: `docs/codex-workflow.md`

**Interfaces:**

```ts
export interface TestGenerationResult {
  generatedTestContent: string;
  correctionAttempted: boolean;
}
```

- [ ] Write a failing test where the first mocked test is structurally invalid and the replacement is valid.
- [ ] Write a failing test where both outputs are invalid and the result is `codex_malformed_output`.
- [ ] Implement one replacement request containing the initial test and exact validation errors.
- [ ] Ensure a valid test that later fails at execution cannot trigger a Codex retry.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
- [ ] Commit with `feat: retry invalid test`, request Person 3 review, then merge.

### Task 7: Integrate with the investigation API and runner handoff

**Branch:** `feat/codex-integration`

**Files:**
- Modify: `apps/server/src/codex/index.ts`
- Modify: `apps/server/src/investigations/*`
- Modify: `apps/server/src/api/*`
- Modify: `apps/server/src/repository/*`

**Interfaces:**

```ts
export interface CodexInvestigator {
  investigate(
    request: InvestigationRequest,
    context: CodexRepositoryContext,
  ): Promise<CodexInvestigationOutput>;
}
```

- [ ] Confirm API events and error mapping with Person 1 before editing their owned files.
- [ ] Confirm the generated test path and existing-test context with Person 3 before editing the handoff.
- [ ] Write an integration test using a mocked investigator and a prepared repository context.
- [ ] Transition state through `analyzing`, `hypothesis_ready`, `generating_test`, and `test_ready` without assigning a final verdict.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke:demo`.
- [ ] Commit with `feat: integrate codex workflow`, obtain Person 1 approval and Person 3 review, then merge.

### Task 8: Stabilize the demo and document evidence

**Branch:** `fix/codex-demo-reliability` followed by `docs/codex-demo-evidence`

**Files:**
- Modify: `apps/server/src/codex/*`
- Modify: `docs/codex-workflow.md`
- Modify: `README.md`

- [ ] Run the complete workflow against the prepared fixture three times.
- [ ] Fix only a verified transport, parser, prompt, or fixture-convention defect.
- [ ] Do not add a new framework, model provider, automated repair, or general debugging chat.
- [ ] Document the model configuration, workflow boundaries, expected demo behavior, and honest limitations.
- [ ] Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run smoke:demo`.
- [ ] Commit each objective separately with short messages, request Person 3 review, and merge.

## Coordination checklist

- [ ] Person 1 approves the hypothesis schema and state/event contract.
- [ ] Person 3 supplies the fixture bug, Playwright configuration, test conventions, workspace path, and artifact format.
- [ ] Person 2 announces any shared-contract change before opening a pull request.
- [ ] Each completed branch is rebased on `origin/main`, tested, reviewed by Person 3, and squash-merged before starting dependent work.
