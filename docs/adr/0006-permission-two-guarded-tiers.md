# ADR-0006: Permission Model — Two Guarded Tiers, No Sandbox Axis

## Status
Accepted

## Context
The permission system had drifted from the harness's guard-rail philosophy (Invariant #4: "escalation over termination") and from its own docs. `auto` — the default — short-circuited to `allow` before any check, so the builtin deny rules (`.env`, `~/.ssh`, `rm -rf /`, fork bomb) and all command rules were dead code: the default ran with **no rails** despite `docs/permissions.md` promising "deny rules still apply". The docs still described a removed `default` mode, a 7-level precedence table that no longer existed, and an `ask` branch the checker never produced. `yolo` was an alias for `auto`, but connoted *no safety net* while `auto` was supposed to keep a floor.

## Decision
A single axis of two guarded tiers (increasing permissiveness):

- **plan** — read-only. Tools that mutate the filesystem or execute shell/code are blocked: `bash`/`edit`/`write`/`eval`/`debug`, the `lsp` write actions (`rename`/`rename_file`/applied `code_actions`), and the `chrome_devtools` interaction ops (`evaluate`/`navigate`/`click`/`fill`/…). Read-only navigation (read/grep/find/symbols/hover/diagnostics, screenshots) still runs.
- **auto** (default) — writes enabled; builtin deny rules enforced as **hard blocks**, never prompted. A *guarded* default.

Dropping the builtin deny floor is **not a third mode**: it is the `disableBuiltinDefaults` setting, surfaced loudly in the UI as "no-rails" whenever the floor is off. It is equivalent to `auto` with the builtin deny list disabled; user-authored `denyPaths`/`denyTools`/`denyCommands` still apply (only the *builtin* defaults drop).

Permissions enforce a floor by default, consistent with Read Guard (hard-block) and Diff Limit (pause). `yolo` is removed. The interactive `ask` branch is removed (no mode produces it).

## Considered Options
- **Keep `auto` = full-open, fix only the docs.** Rejected: leaves the default with no rails and breaks the harness-wide guard-rail invariant.
- **Rename `auto` → `yolo` for honesty, no behavior change.** Rejected: honest about being unguarded, but keeps an unguarded *default* — which is the actual problem.
- **A third, explicit no-rails permission tier (its own mode).** Rejected: the no-rails state is already fully expressed by `auto` + `disableBuiltinDefaults` plus the loud footer alert; a separate permission value would duplicate that semantics for no gain and multiply every downstream cross-product (e.g. Fusion variants). `PermissionMode` stays `plan | auto`.
- **Recover codex's sandbox axis (`workspace-write`).** Rejected: reintroduces the two-axis combinatorial complexity Pit deliberately collapsed; builtins already cover the sensitive targets that matter. Containment is expressed as deny rules, not a cwd jail.

## Consequences
- `auto` becomes a guarded default — no-rails behavior moves behind the explicit `disableBuiltinDefaults` setting.
- The checker must evaluate `denyTools` + builtin path/command rules in `auto` (previously skipped); `findMatchingCommandRule` and `BUILTIN_DANGEROUS_COMMANDS` go from dead code to load-bearing.
- `plan` enforcement keys off `describeToolAction`'s classification, not a tool-name allowlist: a tool with an observable side effect (code execution, workspace write, browser interaction) is mapped to `exec`/`write` and blocked, while read-only and unknown/MCP tools fall through to `tool` and run. New side-effecting built-ins must be classified there to stay honest in read-only mode.
- The dropped-floor state must be visually unmissable (persistent footer alert) to avoid silent unguarded runs; the alert fires whenever the builtin floor is off (`auto` + `disableBuiltinDefaults`).
- No containment to the cwd — a write outside the project in `auto` is allowed unless a deny rule matches.
