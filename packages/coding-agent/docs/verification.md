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
| `mode` | `"in-turn"` \| `"post-turn"` \| `"off"` | `"in-turn"` | Select instruction-first, post-turn gate, or off. Explicit `mode` wins over legacy `enabled`. |
| `enabled` | boolean | `true` | Legacy mapping: `false` → `off`, `true` → `post-turn` when `mode` is absent. |
| `command` | string or null | `null` | Check command to run. `null` auto-detects from `package.json` scripts. |
| `maxAttempts` | number | `2` | Fix attempts before giving up and reporting the failure (min 1). Shared across project check, functional web, and self-review. |
| `timeoutMs` | number | `180000` | Timeout for the check command (min 50ms). |
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

## Command lifecycle, modes, and pending checks

`verification.mode` is `in-turn` (default), `post-turn`, or `off`. The legacy
`enabled` mapping applies only when `mode` is absent and `enabled` is explicitly
provided (`false` → `off`, `true` → `post-turn`); otherwise the default is
`in-turn`. In-turn is instruction-first: after a changed cycle with no verification-class command,
the session steers the model; after two ignored steers, an ordinary task gets a
bounded fallback check. Post-turn drains background checks, runs the verification
gate and fix loop, then drains jobs created by those fixes. Off disables the
automatic gate; explicit checks still run and `goal_complete` keeps its own
applicable safeguards. `PIT_NO_INTURN_CHECK_STEER=1` disables in-turn steering
and fallback; `PIT_NO_FUNCTIONAL_WEB=1` disables the functional-web gate; and
`PIT_NO_SELF_REVIEW=1` disables structured self-review and its completion refusal.

The command-selection fallback is configured command, detected
check/typecheck/lint/test script, local `tsc --noEmit`, then syntax-only checks
for files touched this turn.

Configure the independent pending-check drain as follows:

```json
{
  "pendingChecks": {
    "enabled": true,
    "maxWaitMs": 900000,
    "maxFixAttempts": 2,
    "pollIntervalMs": 500
  }
}
```

`maxWaitMs` is the drain wait budget, `maxFixAttempts` bounds internal fix
prompts, and `pollIntervalMs` is the polling cadence. `PIT_NO_PENDING_CHECKS=1`
forces `enabled: false`, skipping drain and its automatic fixes; it does not
disable promotion, verdict classification, or `goal_complete` gates. When the
drain path runs, this policy is independent of `verification.enabled`.

A verification command starts foreground and is promoted after 10 seconds if
still active. `background: true` is explicit promotion after the startup window
controlled by `PIT_BASH_BACKGROUND_STARTUP_MS` (default 250 ms). Ordinary
commands use `PIT_BASH_AUTO_BACKGROUND_SECONDS` (default 60 s); that knob does
not change the 10-second verification threshold. The `!` path does not consume a
promotion handle and is not silently promoted.

Verification jobs are deduplicated per session owner, canonical cwd, and
normalized command (trimmed, CRLF-normalized, and whitespace-collapsed). A job
with an explicit timeout stores `deadlineAt` from `startedAt`; the timeout is
absolute and promotion does not restart it. A deadline kill sets `timedOut`.
The registry verdicts are `pending`, `passed`, `failed`, and `timed-out`.

Only `post-turn` drains pending jobs before handoff and again after gate fix
turns; `in-turn` does not drain them. `goal_complete` still applies its own
verification-job and goal-gate safeguards independently of that turn drain. `pending_check` session events report drain `waiting`, `passed`, `failed`,
and `timeout`; `verification` events report the foreground gate/fallback's
`running`, `passed`, `failed`, and `timeout` phases. They are distinct events,
and neither is a replacement for the `bg-N` registry result. RPC/JSON transports
the session event stream; there is no separate `pending_check` RPC operation.

`goal_complete` first refuses pending, failed, or timed-out verification jobs;
then it runs goal gates, the applicable configured-check probe, self-review, and
impact safeguards in that order. It only completes after those checks. A drain
handoff or an exhausted wait marks lingering jobs as handled rather than making
an unrelated later prompt wait forever.

## Scoped verification

For targeted verification after a focused change, the model can run a specific
check via the `recipe` tool (task-runner abstraction) instead of the full suite:

```
recipe({ target: "test", args: ["test/specific.test.ts"] })
```

See [recipe tool](#) for details.
