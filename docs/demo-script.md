# FailSpec demo script

This runbook uses the intentionally buggy checkout fixture to demonstrate the approved local-first workflow. Always work from a temporary copy: the tracked fixture is a source artifact and must not be modified.

## Prerequisites and repository boundary

- Node.js 20 or newer and npm are required.
- Use only a trusted local, npm-based Next.js or Vite React repository that satisfies the supported MVP preflight requirements, including its approved Playwright configuration and generated-test script.
- Local mode requires a clean Git working tree. Commit or discard unrelated changes before submitting the temporary fixture path.
- Mock mode does not require Codex, Git preflight, or a supported repository, but the fixture copy keeps the browser demonstration consistent with local mode.

## Automated smoke flow

From the FailSpec repository root, run:

```powershell
npm.cmd run smoke
```

The smoke suite copies `fixtures/buggy-checkout-app` into a fresh temporary directory, initializes and commits that copy, and removes all temporary source, investigation, and owned-worktree paths after every scenario. It exercises the public API with a bounded manual scheduler and bounded GET polling:

- deterministic mock mode reaches `verified` and reloads from the JSON store;
- a local-style workflow uses real preflight, an isolated worktree, generated-test staging, cleanup, and the real classifier with deterministic Codex and runner adapters;
- a classifier-produced `execution_error` remains a structured classified result;
- a thrown runner error becomes a sanitized operational `execution_error` after cleanup.

The smoke suite does not invoke the Codex CLI, launch a browser, or run a real Playwright process. It validates the approved lifecycle composition rather than claiming a real verified reproduction.

## Prepare a disposable fixture copy

Run these commands from the FailSpec repository root. They create a new temporary fixture copy, exclude runtime directories, initialize a local Git repository, and leave the tracked fixture untouched.

```powershell
$fixtureSource = (Resolve-Path .\fixtures\buggy-checkout-app).Path
$demoRoot = Join-Path $env:TEMP "failspec-demo-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $demoRoot | Out-Null
robocopy $fixtureSource $demoRoot /E /XD .git node_modules .failspec playwright-report test-results traces
if ($LASTEXITCODE -gt 7) { throw "Fixture copy failed with robocopy exit code $LASTEXITCODE." }
Set-Location $demoRoot
git init
git config user.email "failspec-demo@example.test"
git config user.name "FailSpec Demo"
Add-Content .git\info\exclude "node_modules/"
git add .
git commit -m "Fixture baseline"
npm.cmd ci
npx playwright install chromium chromium-headless-shell
git status --short
```

The final status command must be empty before submitting this directory in local mode. The fixture intentionally contains a checkout bug: quantity `2` is charged as `$12.00` rather than `$24.00`. `bug-report.md` contains the report to submit. Its manually authored reference test is separate from a generated regression test:

```powershell
npm.cmd run test:reference
```

The reference test passes by confirming the known bug. It is not a FailSpec-generated test and does not prove an investigation result.

## Mock-mode browser demo

In one terminal at the FailSpec repository root, start the API in deterministic mock mode:

```powershell
$env:FAILSPEC_CODEX_MODE = "mock"
npm.cmd run dev:server
```

In a second terminal, start the web application:

```powershell
npm.cmd run dev:web
```

Open the Vite URL displayed by the web server, submit the checkout report from `bug-report.md`, and provide the temporary fixture path as the repository path. The UI polls the public API and displays the deterministic mock `verified` result. Inspect the ordered timeline, hypothesis, analysis evidence, execution evidence, and structured verification result; the evidence is supporting context, not an independently inferred verdict. Select **Start another investigation** to reset the form and submit another report. Mock mode is a UI and API demonstration only: it uses pass-through repository preparation and does not run Git, Codex, staging, or Playwright.

Stop both development servers with `Ctrl+C` when finished.

## Local-mode browser demo

Use local mode only when the Codex CLI is installed and authenticated, and only with the clean, committed temporary fixture copy prepared above. From the FailSpec repository root:

```powershell
$env:FAILSPEC_CODEX_MODE = "local"
npm.cmd run dev:server
```

Start `npm.cmd run dev:web` in a second terminal, open the Vite URL, and submit the same bug report and temporary repository path. Local mode preflights the submitted Git repository, creates a FailSpec-owned isolated worktree, performs read-only Codex analysis and generated-test creation, stages the generated test through the approved boundary, runs it through the controlled Playwright runner, cleans the workspace, and then classifies the sanitized execution evidence.

The generated test is written only in the isolated worktree, never in the submitted source repository. A local result is not `verified` merely because Playwright exits non-zero; the classifier assigns `partial`, `not_reproduced`, or `execution_error` from structured evidence. Real local execution needs the fixture dependencies and Playwright browser installed as above. Do not use an arbitrary, dirty, unsupported, or production repository for this demo.

Stop both development servers with `Ctrl+C` when finished. Inspect the temporary fixture with `git status --short` and confirm its HEAD has not changed.

## Records and safe inspection

When the server runs from the FailSpec repository root, it persists one JSON record per investigation under `.failspec/investigations/`. After stopping the server, inspect registered worktrees safely with:

```powershell
git worktree list
```

Do not manually delete unknown worktree directories. Use the registered list for inspection only; FailSpec-owned cleanup is performed by the workflow. To return a terminal to the default mock-mode selection in a later PowerShell session, clear the environment override:

```powershell
Remove-Item Env:FAILSPEC_CODEX_MODE -ErrorAction SilentlyContinue
```

If the records were created only for this disposable demo and the server is stopped, optional record cleanup is:

```powershell
Remove-Item -LiteralPath .failspec\investigations -Recurse -Force -ErrorAction SilentlyContinue
```

## Safe operational-error demonstration

Do not intentionally damage a repository, worktree, browser installation, or Codex setup to create a failure. Instead, run the deterministic smoke case that injects a controlled runner exception and proves the public result remains sanitized and cleanup occurs once:

```powershell
npm.cmd test --workspace @failspec/server -- investigation-smoke.test.ts -t "safe operational workflow error"
```

This test-only example never starts the Codex CLI or a browser. It demonstrates the distinction between a structured classifier-produced `execution_error` and an operational workflow error, which has no `verification` result.

## Cleanup

When the manual demo is complete, remove only the disposable path that was printed in `$demoRoot`:

```powershell
Set-Location <FailSpec repository root>
Remove-Item -LiteralPath $demoRoot -Recurse -Force
```

Do not remove the tracked `fixtures/buggy-checkout-app` directory. The smoke suite cleans its own temporary paths automatically.
