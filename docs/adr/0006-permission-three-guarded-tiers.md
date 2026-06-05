# ADR-0006: Permission Model — Three Guarded Tiers, No Sandbox Axis

## Status
Accepted

## Context
The permission system had drifted from the harness's guard-rail philosophy (Invariant #4: "escalation over termination") and from its own docs. `auto` — the default — short-circuited to `allow` before any check, so the builtin deny rules (`.env`, `~/.ssh`, `rm -rf /`, fork bomb) and all command rules were dead code: the default ran with **no rails** despite `docs/permissions.md` promising "deny rules still apply". The docs still described a removed `default` mode, a 7-level precedence table that no longer existed, and an `ask` branch the checker never produced. `yolo` was an alias for `auto`, but connoted *no safety net* while `auto` was supposed to keep a floor.

## Decision
A single axis of three guarded tiers (increasing permissiveness):

- **plan** — read-only; `bash`/`edit`/`write` blocked.
- **auto** (default) — writes enabled; builtin deny rules enforced as **hard blocks**, never prompted. A *guarded* default.
- **unsafe** — writes enabled; builtin floor **off**. The explicit no-rails tier for authorized targets, surfaced loudly (footer alert), reachable via `--unsafe` / `/unsafe`. Equivalent to `auto` + `disableBuiltinDefaults`; user-authored `denyPaths`/`denyTools`/`denyCommands` still apply (only the *builtin* defaults drop).

Permissions now enforce a floor by default, consistent with Read Guard (hard-block) and Diff Limit (pause). `yolo` is removed — `unsafe` is the honest name for the no-rails tier. The interactive `ask` branch is removed (no mode produces it).

## Considered Options
- **Keep `auto` = full-open, fix only the docs.** Rejected: leaves the default with no rails and breaks the harness-wide guard-rail invariant.
- **Rename `auto` → `yolo` for honesty, no behavior change.** Rejected: honest about being unguarded, but keeps an unguarded *default* — which is the actual problem.
- **Recover codex's sandbox axis (`workspace-write`).** Rejected: reintroduces the two-axis combinatorial complexity Pit deliberately collapsed; builtins already cover the sensitive targets that matter. Containment is expressed as deny rules, not a cwd jail.

## Consequences
- `auto` becomes a guarded default — no-rails behavior moves behind the explicit `unsafe` mode / `disableBuiltinDefaults`.
- The checker must evaluate `denyTools` + builtin path/command rules in `auto` (previously skipped); `findMatchingCommandRule` and `BUILTIN_DANGEROUS_COMMANDS` go from dead code to load-bearing.
- `unsafe` must be visually unmissable (persistent footer alert) to avoid silent unguarded runs; the same alert should fire whenever the builtin floor is off (e.g. `auto` + `disableBuiltinDefaults`), not only on the literal `unsafe` mode.
- No containment to the cwd — a write outside the project in `auto`/`unsafe` is allowed unless a deny rule matches.
