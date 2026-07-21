# Investigation intake — Jobs to Be Done

## Assumptions to validate

- **User:** a developer who can work in a local Git repository and understands a bug report, but may not know Playwright or FailSpec’s safety model.
- **Context:** a desktop development session, usually while diagnosing a reported failure and wanting useful evidence quickly.
- **Accessibility baseline:** keyboard operation, clear focus, semantic headings, labelled controls, and non-colour-only status signals.

## Job statement

When I receive a failure report for a trusted local app, I want to submit the smallest clear description and understand what FailSpec is doing, so I can decide what evidence to act on without manually creating a regression test first.

## Current solution and pain points

- **Current:** inspect source, reproduce manually, and write/run a Playwright test by hand.
- **Pain:** it is unclear what information is needed, whether the tool is still working, and whether a failed run is evidence of the reported bug.
- **Consequence:** developers either overfill forms, abandon the investigation, or mistake raw execution output for a verified result.

## UX decisions

- Keep the required intake to repository path, reproduction steps, expected behavior, and actual behavior.
- Put optional technical context behind progressive disclosure.
- Explain the clean, trusted-local repository boundary before submission.
- Show only server-authored timeline events and structured evidence; never portray raw command output as proof.
