# Verification Gate

After a code-modifying turn, Pit can run the project's check command and
self-correct on failure. This catches type errors, lint violations, and test
failures introduced by the model before they reach the user.

## How it works

1. After each code-modifying turn (any `edit`/`write`/`bash` that produced
   changes), the verification gate checks whether a check command should run.
2. If triggered, it runs the detected (or configured) check command.
3. On failure, the output is summarized (extracting key error lines) and
   re-injected so the model can self-correct.
4. If the model exhausts its fix attempts (`maxAttempts`), the turn ends
   **blocked** — the agent cannot report success while verification is red.

```
Code change
  │
  ├─► Verification gate triggers
  │     └─► Detect or use configured check command
  │
  ├─► Run check
  │     ├─► Pass ✓ → turn proceeds
  │     └─► Fail ✗ → summarize failures → inject for correction
  │
  └─► If maxAttempts exhausted → turn ends blocked (not done)
```

## Configuration

```json
{
  "verification": {
    "enabled": true,
    "command": null,
    "maxAttempts": 2,
    "timeoutMs": 180000,
    "visual": true,
    "functionalWeb": true,
    "functionalWebTimeoutMs": 45000,
    "functionalWebMaxInteractions": 3
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Run the verification gate after code-modifying turns. |
| `command` | string or null | `null` | Check command to run. `null` auto-detects from `package.json` scripts. |
| `maxAttempts` | number | `2` | Fix attempts before giving up and reporting the failure (min 1). Shared across project check, functional web, and self-review. |
| `timeoutMs` | number | `180000` | Timeout for the check command (min 1000). |
| `visual` | boolean | `true` | Nudge to `preview` when a rendered artifact changed but was never viewed. |
| `functionalWeb` | boolean | `true` | Native functional web DoD: open localhost/preview, a11y structure, smoke clicks/fills, console/network. Fail-open without Chrome. |
| `functionalWebTimeoutMs` | number | `45000` | Wall-clock budget for one functional web check pass. |
| `functionalWebMaxInteractions` | number | `3` | Max click/fill interactions per functional web check. |

## Auto-detection

When `command: null`, Pit auto-detects the check command from `package.json`
scripts in this preference order:

1. `check`
2. `typecheck`
3. `type-check`
4. `lint`
5. `test`

If none are found, it also checks for a local `node_modules/.bin/tsc` and
falls back to `tsc --noEmit` when a `tsconfig.json` exists. If nothing
matches, the gate stays inert (no unnecessary `npx` downloads).

The package manager is detected from the lockfile: `pnpm-lock.yaml` →
`pnpm`, `yarn.lock` → `yarn`, `bun.lock`/`bun.lockb` → `bun`, otherwise `npm`.

## Failure summarization

When a check fails, the verification gate extracts the load-bearing error lines
from the full output:

- TypeScript errors (`TS1234`)
- File:line:col errors (biome, eslint)
- Test failure headers (`FAIL`, `✗`, `●`)
- Thrown exceptions (`Error:`, `AssertionError:`, etc.)

Non-fatal output (passing tests, progress) is dropped. The remaining lines
are capped at the most relevant ones so the model can focus on what failed.

Test-run totals are also parsed into compact headlines: `"✓ 142 passed"` or
`"✗ 3 failed · 142 passed · 1 skipped"`.

## Visual verification

When `visual: true` and a turn modifies rendered artifacts (HTML, CSS, SVG,
UI components), Pit nudges the model to use the `preview` tool to visually
verify the result. This catches layout, styling, and rendering issues that
static checks miss. See the [preview tool](preview.md) for details.

## Functional web DoD

When `functionalWeb: true` (default), after the visual nudge Pit runs a **native**
browser check (no LLM in the loop) for web projects or visual artifacts:

1. Resolve a local URL (touched HTML via ephemeral preview server, or a live
   `localhost`/`127.0.0.1` from a background `dev`/`start` job, or a probed port).
2. Navigate + settle, capture a screenshot for evidence.
3. Accessibility snapshot — require headings/landmarks and interactive controls.
4. Smoke interactions — up to `functionalWebMaxInteractions` safe clicks and at
   most one non-destructive fill (skips password/payment/delete controls).
5. Assert URL or visible text changed when interactions ran (soft signal).
6. Fail on console errors and network status ≥ 400.

Failures re-inject a fix prompt and share `maxAttempts` with the project check
and self-review. Without Chrome, or when the cwd is not a web project / no local
URL can be resolved, the check **skips** (fail-open). Kill-switch:
`PIT_NO_FUNCTIONAL_WEB=1`.

## Pending background checks

If the agent backgrounds a test/check command (via bash with auto-background),
the verification gate tracks it. The agent cannot report the task done or
suggest a commit while such a job is still running. Recognized runners:

- `vitest`, `jest`, `mocha`, `ava`, `playwright`, `cypress`, `pytest`,
  `tox`, `phpunit`, `rspec`
- `tsc`, `tsgo`, `biome`, `eslint`
- Package-manager scripts named `test`, `check`, `lint`, `typecheck`, etc.

Watchers and dev servers (`--watch`, `nodemon`, `dev`, `serve`) are
excluded — they never settle, so waiting on them would stall indefinitely.

## Scoped verification

For targeted verification after a focused change, the model can run a specific
check via the `recipe` tool (task-runner abstraction) instead of the full suite:

```
recipe({ target: "test", args: ["test/specific.test.ts"] })
```

See [recipe tool](#) for details.
