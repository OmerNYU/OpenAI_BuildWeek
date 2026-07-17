# Buggy checkout fixture

This local Next.js fixture intentionally charges for one Field Notebook even when the quantity is two.

## Setup

```sh
npm ci
npx playwright install chromium chromium-headless-shell
```

## Run the reference reproduction

```sh
npm run test:reference
```

The reference test confirms the known buggy output, `$12.00`. The bug report describes the correct expected total, `$24.00`, which a generated regression test should assert.

## Run a generated test

```sh
npm run test:generated
```

Reference tests live in `tests/reference/`. Generated tests belong in `tests/generated/` and must not replace the reference test. Both directories are discovered by the Playwright configuration.
