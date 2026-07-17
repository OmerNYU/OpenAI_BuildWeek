# FailSpec demo script

## Prepare the fixture

```sh
cd fixtures/buggy-checkout-app
npm ci
npx playwright install chromium chromium-headless-shell
```

## Confirm the known reproduction

```sh
npm run test:reference
```

The reference test passes by confirming the intentional bug: setting the quantity to `2` charges `$12.00` instead of the expected `$24.00`.

For the FailSpec demonstration, use `bug-report.md` as the reported failure. Keep the manually authored reference test separate from the generated regression test.
