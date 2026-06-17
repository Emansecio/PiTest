> **Status:** Shipped — commits 7629073d, f8dc43e2, 4cf9ab8b (coordinator fan-out + acceptance gates). Historical record of a delivered feature.

# Design: Acceptance Gates + Dynamic Fanout for the Subagent Coordinator

Date: 2026-05-31
Status: Approved (pending spec review)
Area: `packages/coding-agent/src/core/coordinator` + `built-ins/coordinator-extension.ts`

## Goal

Evolve the native subagent coordinator from "spawn one subagent, return its
output" toward LLM-driven multi-agent orchestration with quality gates, while
keeping everything in-process, automatic, and non-blocking. No human
intervention in the loop; the model decides *when* to orchestrate, the engine
self-manages *how* (depth, concurrency, retries, gates, degradation, cleanup,
permissions).

Two capabilities:

1. **Acceptance gates** — a `task` may require semantic criteria and/or an
   objective command check before its output is accepted; on repeated failure
   it degrades gracefully (returns the last result, flagged) rather than
   erroring or blocking.
2. **Dynamic fanout** — a reusable `parallel` primitive plus a `fanout`
   convenience tool for the `scout → N reviewers → worker` pattern, with the
   reviewer count determined dynamically by the scout.

## Driver Decision

**LLM-driven.** The capabilities are exposed as built-in tools the model calls
(`task` extended, plus `parallel` and `fanout`). There is no separate
deterministic scripting surface. The engine underneath is deterministic and
unit-testable, but invocation is the model's choice.

## Surface

Three LLM-facing tools, all registered by `coordinator-extension.ts` and all
subject to the existing coordinator guarantees: depth guard, permission gate
(headless ⇒ `ask`→`deny`), unique `taskName`, registry tracking, optional
worktree isolation, parent model/auth reuse via `spawnSubagent`.

| Tool | Purpose |
|-|-|
| `task` | Single subagent, now with an optional `acceptance` gate |
| `parallel` | Run an explicit list of subtasks concurrently, collect results |
| `fanout` | scout → N reviewers → worker, built on the `parallel` core |

## Component 1 — Acceptance gate

New module: `coordinator/acceptance.ts`. Reusable by `task` and by the `fanout`
worker stage.

### Parameters (added to the task schema)

```
acceptance?: {
  criteria?: string;       // semantic bar, judged by a fresh judge subagent
  check?: string;          // shell command; passes iff exit code 0
  max_attempts?: number;   // worker attempts including the first; default 2
}
```

A gate with neither `criteria` nor `check` is a no-op (current behavior).

### Flow (inside `task.execute`)

1. Spawn the worker via the existing `spawnSubagent`.
2. Evaluate the gate against the worker's output:
   - **`criteria`** → spawn a fresh **judge subagent** with the worker output +
     criteria, `result_schema = { pass: boolean, reasons: string, missing?:
     string[] }`. The judge is an independent subagent (depth+1,
     permission-gated, counts against `maxDepth`). Its `allowed_tools` default to
     the read-only set (`read`, `grep`, `find`, `ls`) so it can verify file/claim
     evidence without mutating; the judge never receives coordinator tools.
   - **`check`** → run the command through the permission checker
     (`describeToolAction("bash", { command })` → if denied, the gate **fails
     closed**). Passes iff exit code 0. Only stdout/stderr tail is retained.
   - Gate **passes iff every configured check passes** (logical AND).
3. On failure with attempts remaining: spawn a **fresh** worker (each attempt is
   a new stateless `spawnSubagent`, not a resumed instance) with the original
   prompt plus the accumulated gate feedback appended ("Previous attempt
   rejected: `<reasons>` / `<check output tail>`. Address this and retry.").
   Track `lastOutput` + `lastVerdict` across attempts.
4. **Graceful degradation on exhaustion** (key behavior): when `max_attempts` is
   reached without a pass, return the **last attempt's output** (the most recent
   — it incorporated all prior feedback) with:
   - `isError: false` (output *was* produced; it is merely unverified),
   - an inline note prepended to the text: `⚠ Acceptance gate not satisfied
     after N attempts — returning last result.`,
   - `details.gate = { passed: false, exhausted: true, attempts, reasons,
     check_output_tail }`.
5. A worker that genuinely **throws or aborts** (not "bad output") still returns
   `isError: true` — a real failure is distinct from an unsatisfactory result.

### Evidence

On success: `details.gate = { passed: true, attempts, criteria_pass, check_pass,
check_output_tail }`. Evidence travels in the tool-result `details` so the
parent sees *why* something passed or degraded.

### Principle

Never swallow produced work. The gate either accepts output, or returns it
flagged — it never blocks waiting on the user and never discards the result.

## Component 2 — `parallel` primitive

New module: `coordinator/parallel.ts`, exporting `spawnAll`.

```
spawnAll(deps, tasks, { concurrency }) -> Array<{
  taskName: string; ok: boolean; output?: string; value?: unknown; error?: string;
}>
```

- Runs `spawnSubagent` for each task with a **concurrency cap**
  (`PIT_SUBAGENT_MAX_CONCURRENCY`, env, default 5; resolved by a pure helper
  mirroring `resolveMaxSubagentDepth`).
- **`allSettled` semantics**: one task's failure does not abort the others; each
  element reports its own `ok`/`error`. Partial results are always returned.
- Each task entry supports `{ name?, prompt, allowed_tools?, result_schema?,
  acceptance? }` — i.e., parallel subtasks may carry their own gates.

Tool: `parallel({ tasks: [...], concurrency? })` → returns the collected array as
JSON.

## Component 3 — `fanout` tool

Built on `spawnAll`. Captures `scout → N → worker` as one atomic, dynamic
tool call so the reviewer count is decided inside the call (no per-stage
round-trip through the model).

```
fanout({
  scout:    { prompt, allowed_tools?, ... },
  reviewer: { prompt_template, allowed_tools?, ... },   // {{target}} placeholder
  worker:   { prompt, allowed_tools?, acceptance?, ... },
  concurrency?,
})
```

Engine:

1. Spawn the **scout** with `result_schema = { targets: Array<string | object> }`.
2. For each target, spawn a **reviewer**: `reviewer.prompt_template` with
   `{{target}}` substituted (simple string replace; objects are JSON-stringified)
   — run via `spawnAll` under the concurrency cap.
3. Spawn the **worker** with the collected reviewer results injected into its
   prompt. The worker may carry an `acceptance` gate (Component 1).

Returns `{ targets, reviews, worker_output, gate }`. `reviews` includes failed
reviewers (flagged) — partial fanout still yields a result.

Dynamic N = scout-determined.

## Component 4 — Depth-guard generalization

The recursion guard currently strips only `task`. Generalize it:

- `COORDINATOR_TOOL_NAMES = new Set(["task", "parallel", "fanout"])`.
- `buildSubagentToolCatalog` strips **all** coordinator tools from a child's
  catalog and re-adds depth-incremented copies of all of them only while within
  the nesting budget.

Consequence: a subagent at the depth limit sees none of `task`/`parallel`/
`fanout`, so unbounded recursion is impossible via any orchestration path.
Scout, reviewers, worker, and judge are all spawned subagents → depth+1.

## Caps (independent axes)

- **Depth** (vertical nesting): `maxDepth`, default 1 (`PIT_SUBAGENT_MAX_DEPTH`).
- **Concurrency** (horizontal breadth): default 5
  (`PIT_SUBAGENT_MAX_CONCURRENCY`).

Both have safe defaults; neither requires configuration.

## Boundaries / module layout

- `coordinator/acceptance.ts` — gate evaluation (judge spawn + command check +
  retry/degradation loop). Pure-ish; the spawn/exec dependencies are injected.
- `coordinator/parallel.ts` — `spawnAll` + concurrency-cap helper.
- `coordinator/fanout.ts` — fanout orchestration (or kept inside the extension
  if small); depends on `parallel` + `acceptance`.
- `built-ins/coordinator-extension.ts` — registers the three tools, wires
  `spawnSubagent` dependencies (model, modelRegistry, availableTools,
  convertToLlm, permissionChecker, cwd) and the depth-aware catalog.

Every spawn — scout, reviewer, worker, judge — funnels through the existing
`spawnSubagent`, inheriting model/auth, the permission `beforeToolCall` gate,
registry recording (with depth), unique `taskName`, and worktree handling.
Nothing bypasses those paths.

## Testing

- **acceptance**: gate pass; gate fail→retry→pass; exhaustion→graceful degrade
  (last output returned, `isError:false`, `gate.passed:false`); judge verdict
  scripted via the faux provider; command check pass/fail; permission-denied
  check fails closed; real throw still `isError:true`.
- **parallel**: collects N; partial-failure isolation (one throws, others
  succeed); concurrency cap respected (max in-flight ≤ cap).
- **fanout**: scout list → N reviewers → worker receives the collected reviews;
  dynamic N tracks the scout output; `{{target}}` substitution; failed reviewer
  is flagged but does not abort.
- **depth guard**: all three coordinator tools stripped at the limit; present
  below it; pure helpers (`resolveMaxSubagentDepth`, concurrency resolver,
  templating) unit-tested.

Test runner: `vitest` (the coordinator suite already uses the faux-provider
rig). Faux-model tests script judge/scout/worker responses; no network.

## Phasing (ship order)

1. Acceptance gate on `task` (judge first, then command check + degradation).
2. `parallel` primitive + `spawnAll` + concurrency cap + depth-guard
   generalization to include `parallel`.
3. `fanout` on top, adding `fanout` to the coordinator tool set.

## Defaults assumed (overridable)

- `max_attempts` default 2.
- `concurrency` default 5 (`PIT_SUBAGENT_MAX_CONCURRENCY`).
- `{{target}}` templating via string replace.
- Partial failures are non-aborting (`allSettled`).

## Out of scope

- Deterministic/author-driven orchestration scripting surface (the engine is
  deterministic but only the LLM tools are exposed).
- Cross-session persistence of orchestration results (registry remains
  in-memory, session-scoped).
- Parent→child tree reconstruction beyond depth (no `parentId` yet).
- Per-level `/tasks` indentation (depth number only, as today).
