# Agent-scoped Hindsight Memory — Design

Date: 2026-06-21
Status: Approved — decisions locked (see "Locked decisions" below)

## Problem

A subagent type (e.g. `review`) has no way to accumulate type-specific learnings
("recurring bug patterns in this repo") without writing them into the single
shared project hindsight bank, where they pollute every other agent's `recall`.
The reverse is also true: the orchestrator's `recall` surfaces narrow,
subagent-only noise it did not want. The session-summary `learned-errors-test-pollution-fix`
documents exactly this kind of cross-contamination.

The original proposal was a separate `.pit/agents/<agent>.memory.jsonl` injected
wholesale into that agent's prompt. Rejected because:

- Subagents are short-lived and isolated; wholesale prompt injection grows
  unbounded and inflates exactly the cheap (`haiku`) subagents where token cost
  matters most. It re-implements retrieval badly.
- The hard part is the write-back path, not the file format. A parallel store
  duplicates infra (BM25, prune, atomic rewrite, dedup) the bank already has.

This design instead **extends the existing hindsight bank with an agent scope**,
reusing its BM25 retrieval, persistence, and pruning. One store, scoped reads
and writes.

## Locked decisions (optimize for quality)

1. **Auto-enable memory per type.** `memory: true` frontmatter auto-injects
   scoped `recall`+`retain`+`reflect` into a type's catalog. Ship the builtin
   `explore` and `review` types with `memory: true` so the feature is live out of
   the box (they benefit most from cross-session memory). `plan` stays without.
2. **Main agent reads everything, ranked — not filtered.** The orchestrator's
   `recall`/`reflect` default to ALL scopes with a boost on global entries, so
   its own memories rank first and subagent memories appear below (available, not
   dominant). The only hard fence stays *between subagent types*: a typed
   subagent `T` reads `T` + global, never another type's private scope.
3. **Per-scope prune quota in v1.** A chatty subagent scope cannot evict the
   rare, valuable global/decision entries: each non-global scope is independently
   capped (`scopedSubagentsMaxEntriesPerScope`, default 200); the global scope
   keeps the overall `maxEntries` budget.

## Goals

- A typed subagent's `retain` writes are tagged with its agent type.
- A typed subagent's `recall`/`reflect` see its own scope **plus** global
  entries, ranked so own-scope wins ties — but never another type's private
  entries.
- The main agent (and ad-hoc untyped subagents) read ALL scopes by default,
  ranked with a boost on global so the orchestrator never loses information but
  is not flooded by subagent noise.
- Escape hatch: any agent can explicitly read `all`/`global`/a named scope.
- Zero migration: existing `bank.jsonl` entries (no scope) are treated as global.
- Default-on, env opt-out, no new required config.
- Per-scope prune quota protects high-value global memory from chatty scopes.

## Non-goals

- No separate per-agent store file. One bank.
- No automatic distillation of subagent results into memory by the parent.
- No scoping of session-summaries (they stay global — they describe the whole
  session, and the boot-prompt prefix already reads them globally).

## Data model

`packages/coding-agent/src/core/hindsight/types.ts`

Add an optional field to `HindsightEntry`:

```ts
export interface HindsightEntry {
  // …existing fields…
  /**
   * Agent scope that wrote this entry. Undefined = global (main agent or an
   * ad-hoc untyped subagent). A subagent spawned with `type: "<name>"` stamps
   * its type name here, so reads can be scoped per agent type.
   */
  agentScope?: string;
}
```

Extend the search options:

```ts
export interface HindsightSearchOptions {
  query: string;
  limit?: number;
  kinds?: HindsightKind[];
  /**
   * Restrict to these scopes. `null` matches global (undefined agentScope).
   * Omitted = no scope filter (every scope is eligible).
   */
  scopes?: (string | null)[];
  /**
   * When set, results whose agentScope matches are ranked above ties. A string
   * boosts that named scope; `null` boosts global (undefined-scope) entries —
   * used by the main agent to keep its own memory on top while still reading
   * subagent scopes.
   */
  boostScope?: string | null;
}
```

No change to `HindsightSearchResult`.

Back-compat: a JSONL line without `agentScope` parses to `agentScope === undefined`,
which is the global scope. `null` (explicit) and `undefined` are normalized to the
same "global" bucket everywhere.

## Bank changes

`packages/coding-agent/src/core/hindsight/bank.ts`

1. **`add`** — already spreads named fields; add `agentScope: input.agentScope`
   to the constructed entry (so `retain` can pass it through).

2. **`search`** — apply scope filter + boost **after** BM25 scoring, **before**
   `sort`/`slice` (currently at `bank.ts` ~ the `scored.push(...)` loop, then
   `scored.sort(...).slice(0, limit)`):

   - Keep the existing kinds-based `searchStatsFor` corpus and cache **unchanged**
     — idf/avgLen stay computed over the full kinds corpus so scores remain
     comparable across scopes (no cache-key explosion, no per-scope corpus skew).
   - After the scoring loop, if `opts.scopes` is provided, build
     `allowGlobal = scopes.includes(null)` and
     `allowSet = new Set(scopes.filter(s => typeof s === "string"))`, then drop
     any `result` whose `entry.agentScope` is not allowed (undefined →
     allowed iff `allowGlobal`).
   - If `opts.boostScope !== undefined`, multiply `result.score` by
     `SCOPE_BOOST = 1.25` for entries whose scope matches the boost target.
     Normalize first: an entry's effective scope is `entry.agentScope ?? null`
     and the boost target is `opts.boostScope` (which may be `null` to boost
     global). So `boostScope: null` lifts global entries; `boostScope: "review"`
     lifts review entries.
   - Then the existing `sort` + `slice(limit)` runs on the filtered/boosted set.

   Filtering after scoring (not before) costs a few extra BM25 evaluations on a
   small bank — negligible, and it keeps the stats cache keyed only by `kinds`.

3. **Per-scope prune quota (decision 3).** Add a method and call it on open:

   ```ts
   /**
    * Cap each NON-global scope at `perScopeMax`, evicting oldest-by-updatedAt
    * within that scope only. The global scope (undefined agentScope) is exempt
    * — it is governed solely by the overall `enforceLimit(maxEntries)`. This
    * stops a chatty subagent scope from evicting rare, high-value global/decision
    * entries through the shared LRU. Returns count removed.
    */
   enforcePerScopeLimit(perScopeMax: number): number;
   ```

   Implementation: bucket `entries` by `agentScope` skipping `undefined`; for any
   bucket over `perScopeMax`, sort that bucket newest-first and drop the tail;
   remove dropped from `entries` + `byId`, `invalidateSearchStats()`, then one
   `atomicRewrite`. In `openBank`, run order is: `pruneOlderThanDays` →
   `enforcePerScopeLimit(perScopeMax)` → `enforceLimit(maxEntries)` (per-scope
   first so the global ceiling sees an already-trimmed set).

4. No change to `pruneOlderThan` / `enforceLimit` / `delete` / `all` semantics
   (still operate across all scopes); `enforceLimit` stays the global last-resort
   ceiling.

## Tool changes

All four hindsight tools gain an optional bound scope via their existing
`*Options` objects. The bound scope drives default read/write behavior; an
explicit `scope` input param overrides reads.

### `retain` (`tools/retain.ts`)

- `RetainToolOptions` gains `agentScope?: string`.
- In `execute`, pass `agentScope: options?.agentScope` into `bank.add({...})`.
- No schema change (the agent does not choose its own scope; it is bound at
  spawn). Optionally surface the scope in the success line:
  `Retained: <label> [id: …]` → append ` (scope: <name>)` when scoped.

### `recall` (`tools/recall.ts`)

- `RecallToolOptions` gains `agentScope?: string`.
- Add an optional input param to `recallSchema`:

  ```ts
  scope: Type.Optional(Type.String({
    description:
      "Override the search scope: 'own' (this agent's scope + global, the default), " +
      "'global' (global only), 'all' (every scope), or a specific agent-type name.",
  })),
  ```

- Resolve `scopes`/`boostScope` from the bound `agentScope` + the input `scope`:
  - bound scope `S`, input unset or `"own"` → `scopes:[S, null]`, `boostScope:S`.
  - bound scope undefined (main), input unset or `"own"` → `scopes` omitted
    (ALL scopes), `boostScope:null` (boost global). Decision 2: the orchestrator
    reads everything, ranked, never filtered.
  - input `"global"` → `scopes:[null]`, `boostScope` unset.
  - input `"all"` → `scopes` omitted (no filter).
  - input `"<name>"` → `scopes:[<name>, null]`, `boostScope:<name>`.
- Pass `scopes`/`boostScope` to `bank.search(...)`.

### `reflect` (`tools/reflect.ts`)

- Same `agentScope` option + same `scope` input param + same resolution as
  `recall`. Pass through to `bank.search`. (reflect uses `REFLECT_LIMIT` and its
  own packing; only the search call changes.)

### `forget` (`tools/forget.ts`)

- `ForgetToolOptions` gains `agentScope?: string`.
- `id`-based delete stays global (ids are unique across scopes; an explicit id is
  an unambiguous target — keep current behavior).
- `subject`/`tags` resolution must be scope-fenced so a subagent cannot delete
  another scope's entries by subject collision: when `agentScope` is bound,
  filter `bank.all()` candidates to `e.agentScope === agentScope` **or**
  `e.agentScope === undefined` (own + global) before the subject/tags match. The
  main agent (unbound) keeps full reach.

## Plumbing: binding the scope at spawn

`packages/coding-agent/src/core/built-ins/coordinator-extension.ts`

This is the only site that knows a subagent's `type`. The bound scope = the
resolved `agentType.name` (undefined for untyped/ad-hoc spawns).

1. Add a helper (new file `tools/hindsight-scope.ts`, or exported from
   `coordinator-extension.ts`):

   ```ts
   // Replace recall/retain/reflect/forget in a child catalog with instances
   // bound to `scope`. Leaves every other tool untouched. No-op when scope is
   // undefined or scoped hindsight is disabled.
   function withAgentScope(tools: AgentTool[], scope: string | undefined, cwd: string): AgentTool[]
   ```

   It maps the catalog, and for each tool whose `name` is `recall`/`retain`/
   `reflect`/`forget`, substitutes `createRecallTool(cwd, { agentScope: scope })`
   etc. Tools not present in the catalog (because the type's `allowed_tools`
   excludes them) are simply not added — we do not force-inject here.

2. In `makeTaskTool`'s `execute`, after `effAllowedTools` and the child catalog
   are built (`baseChildTools = buildSubagentToolCatalog(...)`), wrap:

   ```ts
   const scope = scopedHindsightEnabled() ? agentType?.name : undefined;
   const baseChildTools = withAgentScope(
     buildSubagentToolCatalog(options.getAvailableTools(), childDepth, maxDepth, makeTaskTool),
     scope,
     cwd,
   );
   ```

   Both the `op:"spawn"` (detached) and `op:"run"` paths use `baseChildTools`,
   so a single wrap covers both. The `messaging` path appends `createMessageTool`
   to `baseChildTools` — order is fine, message is untouched by the wrap.

3. Per-spawn instances mean **no module-global current-scope** — which is
   essential: up to `MAX_CONCURRENCY` (4) subagents of different types run in
   parallel, so a global scope would race. Each subagent closes over its own
   scoped tool instances; the shared bank is pulled at `execute` time via
   `getCurrentHindsightBank()` exactly as today.

4. Resume (Tier 2 from disk, `resumeFromDisk`) and `op:"continue"` rebuild a
   catalog too — apply `withAgentScope` there as well so a resumed typed
   subagent keeps its scope. The persisted `ResumeState` must carry the scope:
   add `agentScope?: string` to the saved state (in `coordinator/resume-store.ts`)
   and re-apply it on reopen.

### Per-type auto-enable memory (decision 1)

Built-in types (`explore`/`plan`/`review`) list restricted `tools` that exclude
recall/retain, so without this they could not use memory even scoped.

- `AgentTypeDef.memory?: boolean` (frontmatter `memory: true`) in
  `coordinator/agent-types.ts` (parse it next to `tools`).
- When `agentType.memory === true`, the spawn adds scoped `recall` + `retain` +
  `reflect` to the child catalog if absent (passed into `withAgentScope` via a
  `{ autoAdd: boolean }` flag, since `withAgentScope` only rewrites tools that
  already exist). `forget` stays opt-in via explicit `tools`.
- **Ship `explore` and `review` with `memory: true`** in
  `coordinator/builtin-agents.ts` so the feature is live out of the box. `plan`
  stays memoryless (it is a one-shot planner, little to accumulate).

Note: a type's `tools` allow-list is enforced by `filterTools` in `spawn.ts`
against `availableTools`. The auto-added scoped tools are appended to the child
catalog (`baseChildTools`) which is passed as `availableTools` WITHOUT an
`allowedTools` filter narrower than the catalog itself for these — confirm during
implementation that auto-added tools survive the `effAllowedTools` filter (if a
type sets `tools:` without recall/retain but `memory:true`, the auto-add must win;
easiest: when `memory:true`, append `recall/retain/reflect` to `effAllowedTools`
too).

## Settings & opt-out

`packages/coding-agent/src/core/settings-manager.ts`

- `HindsightSettings` + `ResolvedHindsightSettings` gain
  `scopedSubagents?: boolean` / `scopedSubagents: boolean` and
  `scopedSubagentsMaxEntriesPerScope?: number` / `: number`.
- `getHindsightSettings()` resolves `scopedSubagents: raw?.scopedSubagents !== false`
  (default-on) and `scopedSubagentsMaxEntriesPerScope` =
  `raw?.scopedSubagentsMaxEntriesPerScope` when a finite int > 0, else `200`.
- `_openHindsightBank()` in `agent-session.ts` passes the resolved per-scope cap
  into `openBank(path, { maxEntries, pruneOlderThanDays, perScopeMax })` so the
  bank runs `enforcePerScopeLimit` on open.
- `scopedHindsightEnabled()` in the coordinator reads this (threaded through
  `CoordinatorExtensionOptions` as a getter, mirroring `isMessagingEnabled`), with
  an env backstop `PIT_NO_SCOPED_HINDSIGHT` for parity with the other subagent
  env opt-outs.

When disabled, `withAgentScope` is a no-op and behavior is identical to today.

## Behavior matrix

| Caller                       | retain writes scope | recall/reflect default reads        |
| ---------------------------- | ------------------- | ----------------------------------- |
| Main agent                   | global (undefined)  | ALL scopes, global boosted          |
| Untyped subagent (ad-hoc)    | global              | ALL scopes, global boosted          |
| Typed subagent `T`           | `T`                 | `T` + global, `T` boosted           |
| Any, `scope:"all"`           | n/a                 | every scope, no boost               |
| Any, `scope:"global"`        | n/a                 | global only                         |
| Any, `scope:"X"`             | n/a                 | `X` + global, `X` boosted           |

## Testing

New/updated vitest files under `packages/coding-agent/test/`:

1. `hindsight-bank-scope.test.ts` (unit, bank):
   - add with/without `agentScope`; persisted line round-trips the field.
   - `search` with `scopes:[null]` excludes scoped entries; `scopes:["review", null]`
     includes review + global, excludes `explore`.
   - `boostScope` lifts an equally-scored own-scope entry above a global one.
   - omitted `scopes` returns all scopes (back-compat with current callers).
   - existing entries (no field) behave as global.

2. `hindsight-tools-scope.test.ts` (unit, tools):
   - `createRetainTool(cwd,{agentScope:"review"})` stamps the scope.
   - scoped `recall` default = own+global; `scope:"global"`/`"all"`/`"<name>"`
     overrides resolve to the right `bank.search` args (assert via an injected
     `bank` stub).
   - scoped `forget` by subject cannot delete another scope's entry.

3. `coordinator-scoped-hindsight.test.ts` (integration via harness/faux provider):
   - a `task({type:"review"})` whose catalog includes recall/retain ends up with
     scoped instances; a retain inside it lands with `agentScope:"review"`; the
     parent's later default `recall` DOES surface it (decision 2: main reads all)
     but a global entry of equal relevance ranks above it (global boost).
     - a `task({type:"explore"})` (builtin `memory:true`) gets scoped recall+retain
     auto-added even though the builtin `tools` list omits them.
     - `PIT_NO_SCOPED_HINDSIGHT=1` → scope is undefined (parity with old behavior).

4. `hindsight-bank-perscope.test.ts` (unit, prune quota):
     - `enforcePerScopeLimit(2)` evicts oldest within a chatty scope only, leaves
     global and other scopes untouched; global is never capped by it.
     - open-time order: per-scope cap runs before the global `enforceLimit`.

Run targeted files per `AGENTS.md`, then `npm run check`.

## Files touched (summary)

- `core/hindsight/types.ts` — `agentScope` on entry; `scopes`/`boostScope` on
  search options.
- `core/hindsight/bank.ts` — persist `agentScope` in `add`; scope filter + boost
  in `search`.
- `core/tools/retain.ts` — `agentScope` option → `bank.add`.
- `core/tools/recall.ts` — `agentScope` option + `scope` input param → search args.
- `core/tools/reflect.ts` — same as recall.
- `core/tools/forget.ts` — `agentScope` option fences subject/tags deletion.
- `core/tools/hindsight-scope.ts` (new) — `withAgentScope` catalog rewriter.
- `core/built-ins/coordinator-extension.ts` — wrap child catalog with scope on
  run/spawn/resume/continue; thread `scopedHindsightEnabled`.
- `core/coordinator/agent-types.ts` — parse `memory` frontmatter into
  `AgentTypeDef.memory`.
- `core/coordinator/builtin-agents.ts` — set `memory: true` on `explore` +
  `review`.
- `core/coordinator/resume-store.ts` — persist/restore `agentScope` on resume.
- `core/settings-manager.ts` — `scopedSubagents` (default-on) +
  `scopedSubagentsMaxEntriesPerScope` (default 200).
- `core/hindsight/bank.ts` + `core/hindsight/index.ts` (`OpenBankOptions`) —
  `perScopeMax` + `enforcePerScopeLimit`.
- `core/agent-session.ts` — pass `perScopeMax` into `openBank`.
- Tests as above.

## Risks / edge cases

- **idf stability**: filtering after scoring keeps BM25 scores comparable; the
  alternative (per-scope corpus) was rejected to avoid cache-key blowup and skew.
- **Resume losing scope**: addressed by persisting `agentScope` in resume state.
- **Built-in types can't use memory by default**: addressed by `memory: true`
  frontmatter, shipped on `explore` + `review` (decision 1).
- **Pruning across scopes**: addressed by `enforcePerScopeLimit` (decision 3) —
  each non-global scope is independently capped so it cannot evict global
  decisions through the shared LRU. `pruneOlderThan` (age-based) stays global by
  design (stale is stale regardless of scope).
