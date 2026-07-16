# Autonomous Goals

Pit supports autonomous goal tracking: a structured state machine that
monitors the objective, token usage, iterations, and elapsed time of the
current task. Goals drive Pit's auto-continuation loop — the agent keeps
working without user input until the goal is complete or the budget is
exhausted.

## Concept

A goal is an autonomous objective the agent pursues across multiple turns:

```
goal_complete ──► complete (summary recorded)
     ▲
     │
start ──► active ──► budget_limited (tokens exhausted)
     │
     └──► paused (user interrupted)
```

- **active**: the agent is working on the goal; auto-continue is enabled.
- **completed**: the agent called `goal_complete` with a summary; turn
  counters are frozen.
- **budget_limited**: the token budget (if set) was exceeded.
- **paused**: user interrupted the autonomous loop.

## Setting a goal

Goals are created through the system prompt when the model infers an
autonomous task from the user's request — or they can be set explicitly
via the slash command:

```bash
/goal "Refactor auth module to use bcrypt" --budget 100k
```

The objective is capped at 4000 characters.

## The `goal_complete` tool

Once every requirement of the goal is satisfied **and** verified
requirement-by-requirement against real output (tests, files, command
results), the model calls `goal_complete`:

```js
goal_complete({
  summary: "Refactored auth module: replaced SHA-256 with bcrypt, "
         + "updated all call sites (12 files), added password policy "
         + "validation, all existing tests pass.",
});
```

The tool is **no-op if no goal is active**. It records:

- Summary text
- Iterations completed
- Token usage
- Elapsed time

## Token budget

Goals can have an optional token budget that limits how much context the
agent can consume on a single objective:

```bash
/goal "Investigate memory leak" --budget 200k
```

Budget formats: `200000`, `200k`, `1.5m`.

When the budget is exceeded, the goal transitions to `budget_limited` and
auto-continue stops. This prevents runaway token consumption on open-ended
tasks.

Goal consumption uses one inclusive rule for every model call:
`input + output + cacheRead + cacheWrite`. The same rule applies to main-agent
turns, Fusion stages, subagents, acceptance retries/judges, and in-memory
resume/continue follow-ups. Cache pricing may be cheaper, but cached tokens still
occupy model context and therefore count against the token budget.

## UI indicators

When a goal is active, the footer shows:

- Braille spinner animation (animates across renders)
- Token usage vs budget (e.g. `45k/100k`)
- Iteration count
- Elapsed time (e.g. `3m`, `1h12m`)

## Status display

Use `/goal` to see the current goal status:

```
Active: "Refactor auth module"
  Iterations: 12
  Tokens used: 45k / 100k
  Elapsed: 3m
```

Use `/goal` when no goal is active to see the last completed goal's summary.

## Auto-continuation

When a goal is active, the agent automatically continues after each turn
without waiting for user input. This happens for:

- **`run` (blocking) subagents** — the parent continues after the subagent
  returns.
- **Direct tool calls** — the next LLM call starts immediately.

Auto-continuation stops when the goal status is no longer `active`
(completed, budget_limited, paused).

## Related

- [Usage: interactive mode](usage.md#interactive-mode) - for the general
  interactive loop.
- [Fusion mode](fusion.md) - multi-model panel for planning and debugging.
- [Subagents](subagents.md) - task decomposition with spawn/join.
