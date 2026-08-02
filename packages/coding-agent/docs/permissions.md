# Permissions

Pit gates every tool call and bash command through a permission system with
four modes on a single axis of permissiveness, plus a deny/allow rule set.
Permissions are enforced regardless of which provider or model you use; the
rules live in your settings and the checker runs before every tool execution.

## Modes

| Mode | Behavior |
|------|----------|
| `plan` | Read-only. Any tool classified `write`/`exec` is blocked (`bash`, `edit`, `write`, `eval`, `debug`, …). Beyond that, every generic `type:"tool"` action is gated by its declared side effect (`src/core/permissions/side-effect.ts`): `agent` (coordination/subagent tools — `task`, `parallel`, `fanout`, and `goal_complete`), `workspace` (e.g. `memory_append`), and `exec` are all denied; only `none` (read-only) passes. A tool with no declared side effect defaults to `opaque` and is denied fail-closed. There is no read-only carve-out for subagents in plan mode — `task`/`parallel`/`fanout` stay fully blocked, so research/delegation is done by calling the read-only tools directly instead of spawning a subagent. Reads still honor deny rules. Useful for exploration / planning passes. |
| `ask` | Read-only, **enforced exactly like `plan`** — same blocked action types, same side-effect gating, same MCP denial, same read behavior honoring deny rules. What differs is the stance asked of the model, not what the checker allows: `ask` is a Q&A posture (Cursor-style). The agent answers your question directly from the code — it does not build a plan DAG and never calls `exit_plan`. If you ask for code changes, it tells you to switch modes instead. Useful for "explain this", "where does X happen", "is this safe" passes. |
| `confirm` | Same enforcement as `auto` with one difference: a mutation the allowlists do not cover **pauses for your approval** instead of just running. Reads run free. See [Confirm (approve each mutation)](#confirm-approve-each-mutation). |
| `auto` | **Default.** Writes and commands run without prompts, but the built-in deny floor is enforced as **hard blocks**: sensitive paths (`.env`, `~/.ssh/**`, …) and dangerous commands (`rm -rf /`, fork bomb, …) are denied. A *guarded* default. |

The built-in floor can still be dropped per-session by setting
`disableBuiltinDefaults: true` (see below) — a **no-rails** state surfaced
loudly in the footer. **User-authored** `denyPaths`/`denyCommands`/`denyTools`
still apply. For authorized targets only.

Override the configured mode for a single run with
`--permission-mode plan|ask|confirm|auto`. Switch mid-session with the
`/permission-mode <mode>` slash command, or cycle through the Modes with
`alt+p` (`Plan → Ask → Auto → Fusion · Plan → Plan`).

**`confirm` is not in the `alt+p` cycle.** The cycle is still the same four
stops. Confirm is a deliberate, sticky choice — every mutation costs you a
keystroke — so it is reachable only via `/permission-mode confirm` or
`--permission-mode confirm`, never by cycling past it. (Pressing `alt+p` while
in `confirm` re-enters the loop at `Plan`, so a stray keypress never makes the
session more permissive.)

In channels without an interactive surface (print/JSON and RPC), a mutating
action in `plan` or `ask` is denied with a reason — the permission layer never
falls back to asking the user to approve it. `confirm` denies there too, since
there is nobody to approve.

For those headless channels there is one orthogonal knob on top of the modes:
`allowlistOnly` (`--allowlist-only`), the fail-closed CI preset — see
[Fail-closed (CI)](#fail-closed-ci). It is not a mode and does not appear in the
cycle.

## Configuration

`settings.json` (project or global):

```json
{
  "permissions": {
    "mode": "auto",
    "allowPaths": [
      { "glob": "**/src/**", "reason": "trusted source tree" }
    ],
    "denyPaths": [
      { "glob": "**/.env*" },
      { "glob": "**/node_modules/**", "tools": ["write", "edit"] }
    ],
    "denyCommands": [
      { "pattern": "git\\s+push\\s+--force", "reason": "no force push" }
    ],
    "allowCommands": [
      { "pattern": "^npm test", "reason": "only consulted under allowlistOnly / confirm" }
    ],
    "allowTools": ["read"],
    "denyTools": [],
    "disableBuiltinDefaults": false,
    "allowlistOnly": false
  }
}
```

### Path rules

- `glob` uses `*` (single segment), `**` (any path including separators), `?`
  (single character). Patterns are case-insensitive on Windows.
- Tool inputs are resolved to absolute paths before matching, so
  `**/.env*` matches both `./project/.env` and `/etc/.env.prod`.
- `tools` (optional) restricts the rule to specific tool names.
- `reason` is shown in deny errors.

### Command rules

- `pattern` is a regular expression source string. Default flags are `i`
  (case-insensitive). Override per-rule with `flags`.
- Patterns are tested against the raw bash command line.
- Invalid patterns are silently ignored — the rule just never fires.

### Precedence

Within a single check the order is:

1. `denyTools[name]` → **deny** (every mode)
2. **plan / ask** only: `write` / `exec` action types, and `type:"tool"` actions whose side effect is `agent` (`task`/`parallel`/`fanout`/`goal_complete`), `workspace` (e.g. `memory_append`), `exec`, or unclassified (`opaque`, the fail-closed default) → **deny** (read-only)
3. **plan / ask** only: `mcp__*` → **deny** always (MCP cannot be opted in via `allowTools`; leave the read-only modes to use MCP)
4. `allowTools[name]` → **allow** (skips remaining checks; in plan/ask this can reopen sensitive reads or non-MCP custom tools already past step 2)
5. `denyPaths` (reads in `plan`/`ask`; reads + writes in `auto`) and
   `denyCommands` (exec in `auto`), including the built-in defaults
   unless the floor is off → **deny**
6. `allowPaths` → **allow**
7. Terminal:
   - default → **allow**
   - with `allowlistOnly: true` (see [Fail-closed (CI)](#fail-closed-ci)) → **allow**
     only for reads, writes fully covered by `allowPaths`, commands matching
     `allowCommands`, and tools with no side effect; **deny** otherwise
   - in mode `confirm` (see [Confirm](#confirm-approve-each-mutation)) → the same
     split, but what falls outside the allowlists **asks you** instead of being
     denied. `allowlistOnly` is evaluated first, so when both are on, nothing
     prompts

Steps 2 and 3 are the single read-only path shared by `plan` and `ask`: the
checker takes exactly the same branch for both, so anything blocked in one is
blocked in the other. Steps 1 and 4–6 are identical for `auto` and `confirm` —
only the terminal in step 7 differs.

The built-in floor (the defaults in step 5) is active in every mode and off in
any mode with `disableBuiltinDefaults: true`.

### Built-in defaults

Unless `disableBuiltinDefaults: true`, Pit adds:

- Deny paths: `**/.env`, `**/.env.*`, `**/.git/config`, `**/.ssh/**`,
  `**/.aws/credentials`, `**/.npmrc`, `**/id_rsa`, `**/id_ed25519`.
- Deny commands: recursive `rm -rf /` and `rm -rf ~`, classic fork-bomb,
  `mkfs` / `dd if=… of=/dev/`, `chmod -R 777 /`.

Disable when you're testing the system itself, or when working an authorized
target where the floor gets in the way. The dropped-floor (no-rails) state is
surfaced loudly in the footer so it is never on by accident.

## Confirm (approve each mutation)

`permissions.mode: "confirm"` (or `--permission-mode confirm`, or
`/permission-mode confirm`) runs the **whole `auto` chain unchanged** —
`denyTools`, the `allowTools` bypass, and every deny rule including the built-in
floor — and swaps only the terminal. Where `auto` would silently allow, `confirm`
stops and asks you:

| Action | In `confirm` |
|--------|--------------|
| `read` | **allow** — deny rules already ran; confirm gates mutations, not reading |
| `write` | **allow** with no prompt if **every** path matches `allowPaths`; otherwise **ask**. A write that exposes no path (e.g. a browser interaction op) always asks |
| `exec` | **allow** with no prompt if the command matches `allowCommands`; otherwise **ask** |
| `tool` | **allow** when the tool declares no side effect; **ask** for `workspace`/`exec`/`agent`/`opaque` and every `mcp__*` |
| `task` / `parallel` / `fanout` | **deny** — a subagent runs headless and cannot raise an approval prompt. Put the spawn tool in `allowTools` if you want it anyway |

It is the mirror image of [fail-closed](#fail-closed-ci): the same three lists
(`allowPaths`, `allowCommands`, `allowTools`) are the "don't ask me again"
surface. `allowlistOnly` **denies** what they don't cover; `confirm` **asks**
about it. If both are set, `allowlistOnly` wins and nothing ever prompts — that
preset exists for CI, which must never park on a question.

### The prompt

Each pending mutation opens a picker with three choices:

| Choice | Effect |
|--------|--------|
| **Deny** | Blocks the call; the model is told why (any comment you attach is forwarded). Listed first, so any path that auto-answers a prompt lands on the safe option |
| **Allow once** | Runs this call. The next equivalent call asks again |
| **Allow for session** | Runs this call **and stops asking** for calls the recorded rule covers |

**Allow for session** records an in-memory rule — it is never written to
`settings.json` and it disappears when the session ends. The prompt shows the
exact rule before you grant it:

| Action | What is remembered |
|--------|--------------------|
| `write` | `allowPaths += <absolute path>` — one glob per path of that call, exactly the path approved |
| `exec` | `allowCommands += ^<executable>\s+<subcommand>\b` — e.g. approving `git push origin main --force-with-lease` records `^git\s+push\b`. Flags and targets are outside the pattern, and a different subcommand (`git reset`) still asks |
| `tool` | `allowTools += <tool name>` |

An action with nothing matchable (a mutating tool that exposed no path, an empty
command line) drops the "for session" option rather than offering a grant it
cannot honor.

Escape, an interrupt, or a prompt timeout **denies** — fail-closed. Deny rules
still win over everything: a write to `.env` is blocked outright and never
reaches a prompt you could say yes to.

### Where it does not work

`confirm` needs a human on the other end, so outside the interactive channel it
denies with an actionable reason:

```
confirm mode requires an interactive session to approve "write → src/x.ts" —
run interactively, or use auto (or allowlistOnly for CI).
```

That covers print/JSON mode, RPC, and subagents (which run headless even when
the parent session is interactive). For unattended runs use `auto`, or
`allowlistOnly` when you want a hard allowlist.

## Fail-closed (CI)

`permissions.allowlistOnly: true` (or `--allowlist-only`) flips the terminal
decision from allow to **deny**. It is **not a mode**: it never enters the
`alt+p` cycle (`Plan → Ask → Auto → Fusion · Plan`) and combines with any
`--permission-mode` (including `confirm`, which it overrides — see
[Confirm](#confirm-approve-each-mutation)). It is built for headless channels (print/JSON, RPC, CI),
where nothing can prompt anyway — under it, only what you pre-approved runs:

| Action | Under `allowlistOnly` |
|--------|-----------------------|
| `read` | **allow** — deny rules (including the sensitive-path floor) already ran; free reads are the point |
| `write` | **allow** only if **every** path of the call matches `allowPaths`. A multi-file edit where one path is uncovered is denied whole. A write that exposes no path at all (e.g. a browser interaction op) is denied — unverifiable is not the same as safe |
| `exec` | **allow** only if the command line matches an `allowCommands` rule. Tools classified as `exec` with no shell line (`eval`, `code`, `recipe`, `preview`, `debug`) never match, so they are denied |
| `tool` | **allow** only when the tool declares no side effect. Anything `workspace` / `exec` / `agent` / unclassified (`opaque`) — every `mcp__*` included — is denied |

Everything before the terminal is unchanged, so the escape hatches are the usual
ones, in the usual order: `denyTools` still wins over everything, `allowTools` is
still an explicit bypass (the only way to let an MCP or side-effecting tool
through), and `denyPaths` / `denyCommands` still beat the allowlists. Deny
reasons from this tier are prefixed `Fail-closed (permissions.allowlistOnly):`
so they are never confused with a rule hit. A regex budget overrun while testing
`allowCommands` also denies (fail-closed). In the interactive channel the state
shows in the footer as `auto·fail-closed`; `no-rails` still wins the label when
the built-in floor is also off.

Recipe — a CI run that may only edit the source tree and only run the test suite:

```json
{
  "permissions": {
    "mode": "auto",
    "allowlistOnly": true,
    "allowPaths": [
      { "glob": "**/src/**", "reason": "source tree" }
    ],
    "allowCommands": [
      { "pattern": "^npm test", "reason": "test suite" }
    ],
    "allowTools": ["read", "grep", "ls", "find"]
  }
}
```

Globs are matched against **absolute** paths (see [Path rules](#path-rules)),
hence the leading `**/`. `allowTools` here is optional — those tools are already
side-effect-free — but listing them documents the intended surface. The same
run without a settings file: `pit -p "fix the failing test" --allowlist-only`,
with the allowlists coming from the project `settings.json`.

## Audit

Permissions emit a decision (`allow` / `deny`) per tool call — in `confirm` mode
the audit line carries the **resolved** verdict, after the user answered, never
the intermediate "ask the user" state. To stream them,
register an extension and pass an `onPermissionDecision` callback when bundling
built-ins through the SDK (see `core/built-ins/permissions-extension.ts`).
