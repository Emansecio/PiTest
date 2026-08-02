# Modes & permissions

**Canonical docs (read these when reachable):**
`packages/coding-agent/docs/permissions.md` · `packages/coding-agent/docs/fusion.md` ·
`CONTEXT.md` (glossary) · `packages/coding-agent/docs/settings.md` (§ Permissions).
**Code anchors:** `src/core/built-ins/permissions-extension.ts` (mode cycle,
`nextFusionCycleState`), `src/core/permissions/side-effect.ts` (side-effect
classification), `src/core/fusion/`.

## The Mode is two facets

A **Mode** is a *Permission* facet plus an *Orchestration* facet — but only four
combinations exist. `alt+p` (`app.permission.cycle`, also `/permission-cycle`)
walks them in order:

```
Plan  →  Ask  →  Auto  →  Fusion · Plan  →  Plan
```

There is no `Fusion · Ask` and no `Fusion · Auto`: Orchestration `fusion`
implies Permission `plan`. From `Fusion · Plan` the cycle key returns to plain
`Plan` (solo).

| Permission | Enforcement | Stance expected of the model |
|---|---|---|
| `plan` | Read-only | Research, produce a Plan, present it for approval |
| `ask` | Read-only — **identical checks to `plan`** | Q&A: answer directly, no Plan, no approval ritual; point at another Mode when asked to change code |
| `confirm` | Guarded writes + a human gate: each uncovered mutation waits for approval | Work normally, but batch mutations (each one interrupts the user); no plan ritual; a denial is a decision, not a retry signal |
| `auto` (**default**) | Guarded writes | Work normally; the deny floor is a hard block |

`plan` and `ask` are indistinguishable in *what they allow*. Never describe `ask`
as "weaker plan" or "more permissive" — only the stance differs.

**`confirm` is NOT a cycle stop.** The `alt+p` loop is still exactly the four
stops above; `confirm` is reachable only via `/permission-mode confirm` or
`--permission-mode confirm`. It is also not read-only: it executes, it just asks
first.

## What read-only actually blocks

In `plan`/`ask`:

- Any action typed `write` or `exec` (`bash`, `edit`, `write`, `eval`, `debug`, …).
- Generic `type:"tool"` actions gated by their declared side effect: `agent`
  (`task`, `parallel`, `fanout`, `goal_complete`), `workspace` (e.g.
  `memory_append`) and `exec` are denied. Only side effect `none` passes. A tool
  with no declared side effect is `opaque` and is denied **fail-closed**.
- All `mcp__*` tools — MCP cannot be re-opened via `allowTools` in read-only modes.
- There is **no read-only carve-out for subagents**: delegation stays blocked, so
  research is done by calling the read-only tools directly.

Reads still honor deny rules in every mode.

## Precedence inside one check

1. `denyTools[name]` → deny (all modes)
2. plan/ask only: `write`/`exec` action types + `agent`/`workspace`/`exec`/`opaque`
   side effects → deny
3. plan/ask only: `mcp__*` → deny
4. `allowTools[name]` → allow (skips the rest; in plan/ask can reopen sensitive
   reads or non-MCP custom tools already past step 2)
5. `denyPaths` (reads in plan/ask; reads + writes in auto) and `denyCommands`
   (exec in auto), including the built-in floor → deny
6. `allowPaths` → allow
7. otherwise → allow, unless `permissions.allowlistOnly` is on (deny — see below)
   or the mode is `confirm` (ask the user — see below). `allowlistOnly` is
   evaluated first, so with both on nothing ever prompts.

## Confirm: `permissions.mode: "confirm"`

Steps 1-6 are byte-for-byte the `auto` chain; only step 7 changes. What the
allowlists cover runs silently, what they do not covers prompts:

- `read` → allow. `write` → allow when EVERY path matches `allowPaths`, else ask.
  `exec` → allow on an `allowCommands` match, else ask. `tool` → allow when side
  effect is `none`, else ask (`mcp__*` always asks).
- `task`/`parallel`/`fanout` → **deny**: a subagent runs headless and cannot raise
  an approval prompt. `allowTools` is the deliberate way in.
- The prompt offers **Deny** (first, so any auto-answer is safe) / **Allow once** /
  **Allow for session**. "For session" records an in-memory rule only —
  `allowPaths += <absolute path>`, `allowCommands += ^<exe>\s+<subcommand>\b`, or
  `allowTools += <tool>` — never written to `settings.json`.
- Escape / interrupt / timeout → deny (fail-closed). Deny rules still win, so a
  blocked path never reaches a prompt.
- Headless channels (print/JSON, RPC, subagents) deny with:
  `confirm mode requires an interactive session to approve "<x>" — run
  interactively, or use auto (or allowlistOnly for CI).`

## Fail-closed (CI): `permissions.allowlistOnly`

Not a mode and not in the `alt+p` cycle — an orthogonal flag
(`--allowlist-only`, or settings) for headless channels. It flips step 7 from
allow to **deny**: reads stay free, writes need EVERY path covered by
`allowPaths`, commands need an `allowCommands` match (same shape as
`denyCommands`), and only side-effect-free tools pass — everything else,
`mcp__*` included, must be listed in `allowTools`. Steps 1-6 are unchanged, so
deny rules still beat the allowlists. Footer shows `auto·fail-closed`. It reads
the same three lists as `confirm` and is its mirror: deny vs. ask.

## The built-in floor

Active in every mode unless `permissions.disableBuiltinDefaults: true`.

- Deny paths: `**/.env`, `**/.env.*`, `**/.git/config`, `**/.ssh/**`,
  `**/.aws/credentials`, `**/.npmrc`, `**/id_rsa`, `**/id_ed25519`.
- Deny commands: recursive `rm -rf /` and `rm -rf ~`, classic fork bomb, `mkfs`,
  `dd if=… of=/dev/`, `chmod -R 777 /`.

Dropping the floor is a **no-rails** state and is surfaced loudly in the footer.
User-authored `denyPaths`/`denyCommands`/`denyTools` still apply when it is off.

## Switching modes

- `--permission-mode plan|ask|confirm|auto` for a single run.
- `/permission-mode <mode>` mid-session — the only way in to `confirm`.
- `alt+p` cycles the four Modes; if no Panel is configured yet it opens `/fusion`
  instead of entering an empty Fusion. It never lands on `confirm`; pressing it
  while in `confirm` re-enters the loop at `Plan`.

In channels without an interactive surface (print/JSON, RPC) a mutating action in
`plan`/`ask` is **denied with a reason** — the permission layer never falls back
to asking the user to approve it. `confirm` denies there too, since there is
nobody to answer.

## Rule shapes (settings.json)

`permissions.allowPaths` / `denyPaths`: `{ glob, tools?, reason? }`. Globs use `*`
(one segment), `**` (any, including separators), `?`; case-insensitive on Windows;
inputs are resolved to absolute paths before matching.
`permissions.denyCommands` / `allowCommands`: `{ pattern, flags?, reason? }` — `pattern` is a regex
source tested against the raw command line, default flag `i`; an invalid pattern
is silently ignored (the rule simply never fires).

## Fusion in one screen

Same credentials as the session — no separate CLI login.

- **Panel**: two members, each `{ cli: "claude" | "codex", model }`, run in
  parallel (same-CLI launches staggered by `staggerSameCliMs`, default 400 ms).
  Configured with `/fusion`, *not* `/model`.
- **Judge** → consensus, contradictions, partial coverage, unique insights, blind
  spots, plus claims flagged as unsupported.
- **Verifier** (`verify`, default on) → read-only fact-check of those claims
  (`read`, `grep`, `find`, `ls`, `symbol`, `find_symbol`), gated by the session
  permission checker.
- **Writer** → the final answer, correcting refuted claims and hedging unverified
  ones.

The **Synthesizer** (judge + writer) is the active `/model`; Panel members are
never the synthesizer. Provider → CLI mapping: `anthropic` → `claude`,
`openai-codex` → `codex`. If both members fail, Fusion degrades to a solo turn
with a note; with one survivor the judge is skipped (`degraded: "solo-synth"`).
Settings live under `fusion` in `settings.json`.
