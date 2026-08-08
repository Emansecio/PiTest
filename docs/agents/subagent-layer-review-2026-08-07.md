# Subagent layer review — 2026-08-07

> Audit of Pit’s subagent / coordinator layer. The original review and its
> revalidation were read-only. A later incident patch added immediate detached
> cancellation publication and a canonical model-alias hint; those changes are
> recorded below and are not a mandate to redesign the layer.
>
> Companions:
> - [`already-built.md`](already-built.md) — what already ships (check before re-proposing basics)
> - [`prevention-layers.md`](prevention-layers.md) — guard pipeline
> - [`packages/coding-agent/docs/subagents.md`](../../packages/coding-agent/docs/subagents.md) — user-facing contract
> - [`packages/coding-agent/docs/permissions.md`](../../packages/coding-agent/docs/permissions.md) — plan/ask/confirm/auto + RO delegation
> - [`docs/superpowers/specs/2026-08-07-agent-orchestration-hardening-design.md`](../superpowers/specs/2026-08-07-agent-orchestration-hardening-design.md) — related hardening design

**Why this file exists.** Agents asked to “improve subagents” often re-propose
spawn, concurrency caps, resume, digests, or worktrees — all already implemented and
extensively tested. This review states what is mature, where residual risk lives, and
which incremental improvements still pay off. Source inspection and focused tests do
not, by themselves, prove production readiness under prolonged real workloads. Prefer
measuring or polishing these seams over inventing a second coordinator.

**Method.** Four parallel read-only explore agents (lifecycle, slots/fanout/worktree,
resume/output/budget, permissions/tests) plus direct inspection of
`packages/coding-agent/src/core/coordinator/*` and `built-ins/coordinator-extension.ts`.

---

## 1. Verdict in one line

The subagent layer is **mature and extensively tested**. There is no evidence that it
requires a structural rewrite. Residual value is mostly incremental: token-budget
symmetry on re-drives, honest large-output recovery, prompt/documentation consistency,
observability, and a few explicitly optional product controls.

| Area | Maturity | Notes |
|------|----------|--------|
| Lifecycle (`run` / `spawn` / `join` / `cancel`) | **High** | Real Agent abort, partial recovery, generation races, Esc/dispose wiring |
| Concurrency / anti-deadlock | **High** | Process-wide slot + lease yield + `withoutLease` + dense tests |
| Parallel / fanout | **High / Med–High** | Parallel solid; fanout solid pipeline, weak empty/all-fail product policy |
| Worktrees | **High (native isolation)** | Not an OS sandbox; MCP/host tools escape by design |
| Resume Tier-1 / Tier-2 | **High** | Redacted disk, 7d TTL, turn checkpoints, strong tests |
| Continue | **Medium** | Same session only; silent FIFO eviction |
| Digest / `op:read` | **Med–High** | Strong in-session; “integral” still wraps ~96KB; no paging |
| Token budget | **Med–High** | Spawn/fanout/disk-resume reserve; live resume/continue do not pre-reserve |
| Permissions + guards | **Med–High** | RO proof exists, but Plan/Ask model-facing prompts still deny that carve-out |
| Observability | **Medium** | `list` + hooks exist; manifest/cost/budget poorly surfaced |

---

## 2. Architecture map (what already exists)

```
task / parallel / fanout          coordinator-extension.ts (~3k lines)
        │
        ├─ spawnSubagent          spawn.ts (~1.3k)  — one live child Agent
        │     ├─ slots.withRunSlot                  — 1 slot per live Agent
        │     ├─ SubagentRegistry                   — pending → terminal (cap 64)
        │     ├─ guards + PermissionChecker
        │     ├─ worktree + retargetToolsForWorktree
        │     └─ runWithAcceptance (judge / shell check)
        ├─ parallel.spawnAll      allSettled + concurrency clamp
        ├─ fanout.runFanout       scout → N reviewers → worker
        ├─ resume-store           .pit/subagents/   — Tier-2 after restart
        └─ output-store           session temp dir  — integral for op:read
```

### `task` ops

| Op | Role |
|----|------|
| `run` | Blocking spawn; returns final answer (digest when large) |
| `spawn` | Detached; returns handle |
| `poll` / `join` | Status / await detached handles |
| `cancel` | Abort detached or in-flight resume/continue by handle |
| `list` | Registry + async + resumable + continuable + slot stats |
| `agents` | List types from `.pit/agents/` |
| `resume` | Continue interrupted run (live Agent or disk Tier-2) |
| `continue` | Follow-up on successfully finished Agent (same session) |
| `read` | Recover stored integral output by handle |

### Caps (defaults)

| Axis | Default | Env / note |
|------|---------|------------|
| Nesting depth | `1` | `PIT_SUBAGENT_MAX_DEPTH` (`0` disables) |
| Live Agents | `4` | `PIT_SUBAGENT_MAX_CONCURRENCY` |
| Queue past cap | `8 × concurrency` | `PIT_SUBAGENT_MAX_QUEUE` |
| Inline digest | `4 KB` head+tail | `PIT_SUBAGENT_MAX_BYTES` |
| Continuable / resumable memory | FIFO `8` live Agents | fixed |
| Persisted resume TTL | `7 days` | fixed |
| Max turns | `50` | per-call `max_turns` |

### Module sizes (maintenance context)

| Module | ~Lines | Role |
|--------|--------|------|
| `coordinator-extension.ts` | ~3200 | LLM surface (ops, schema, session wiring) |
| `spawn.ts` | ~1350 | Child Agent runtime |
| `slots.ts` | ~270 | Process-wide budget + nested yield |
| `fanout.ts` / `parallel.ts` | ~275 / ~215 | Horizontal orchestration |
| `resume-store.ts` / `output-store.ts` | ~170 / ~180 | Durability layers |

### Key paths

| Role | Path |
|------|------|
| Public coordinator exports | `packages/coding-agent/src/core/coordinator/index.ts` |
| Spawn runtime | `packages/coding-agent/src/core/coordinator/spawn.ts` |
| Slots | `packages/coding-agent/src/core/coordinator/slots.ts` |
| Parallel / fanout | `packages/coding-agent/src/core/coordinator/parallel.ts`, `fanout.ts` |
| Registry / resume / output | `registry.ts`, `resume-store.ts`, `output-store.ts` |
| Worktree rebind | `worktree-tools.ts` |
| Tool surface | `packages/coding-agent/src/core/built-ins/coordinator-extension.ts` |
| Guard propagation | `packages/coding-agent/src/core/built-ins/subagent-guards.ts` |
| Token ledger | `packages/coding-agent/src/core/token-governor.ts` |
| Tests | `packages/coding-agent/test/coordinator-*.test.ts` (25 files in this snapshot) + permissions/guards suites |

---

## 3. What is already solid (do not reinvent)

1. **Real cancellation** — abort reaches the Agent; slot held until settlement
   (`holdCurrentSlotUntil`); listeners cleaned on settle (H18); worktree quiescence
   before remove.
2. **Nested anti-deadlock** — `SlotLease` + AsyncLocalStorage; yield on nested spawn and
   on `join`; detached `op:spawn` uses `withoutLease` so parent lease is not re-entered
   after the spawning turn dies.
3. **Single concurrency chokepoint** — blocking, detached, parallel children, fanout
   stages, judges, resume/continue all pay one slot via `withRunSlot` (no longer
   “one slot per tool call”).
4. **Digest + recovery** — parent context gets head+tail + pointer; `op:read` retrieves
   the stored session text before the tool wrapper applies its ~96KB head+tail cap.
5. **Plan/ask fail-closed with host proof** — trusted `readOnlyDelegation` only when the
   effective child catalog is side-effect-free, with no worktree/MCP/acceptance; child
   inherits parent mode so mutations still deny even if catalog were wrong.
6. **Guard propagation** — same grounding factories + destructive fire-once + learned-error
   on a per-spawn chain; not a half-port of parent predicates.
7. **Resume on disk** — atomic redacted write, collision-safe stems, turn checkpoints,
   failed-resume rewrite, kept-worktree cwd rebind.
8. **Canonical docs honesty** — `subagents.md` and `permissions.md` state limits
   (no wall-clock timeout, host tools not rebound, etc.).

Historical failure modes already closed in code + tests include H18 (stale abort
listeners on continue/resume), H20 (partial worktree garbage), H21 (resume stem
collisions), and parallel “queue full” from over-eager concurrency (clamp to slot cap).

---

## 4. Lifecycle and cancellation (context)

### Flow

```
registry.create → status running
controller + parent signal link
withRunSlot → runSpawned:
  worktree? (abort-aware create)
  filter / retarget tools
  new Agent (in-memory session; turns never hit parent session file)
  turn_end: usage, checkpoint, progress, turn-cap
  race(agent.prompt, abort)
  transport retry / model auth fallback / soft retry
  classify completed | failed | cancelled (+ partial)
  cleanup once: unsub, listeners, onSettle, worktree cleanup
```

### Cancellation sources

| Source | Effect |
|--------|--------|
| Esc / `AgentSession.interrupt()` | Abort detached pending + parent Agent (blocking inherits turn signal) |
| `task({ op: "cancel" })` | Abort pending detached **and** resume/continue lifecycle controllers |
| Turn cap | Abort only if the capped turn still called tools |
| Session dispose | Abort running + finite grace + clear maps + `outputStore.dispose` |
| Join abort | Does **not** kill detached subagents (by design; message says they continue) |

### Residual lifecycle risks

| Risk | Current mitigation | Residual |
|------|--------------------|----------|
| Orphan Agent after abort | `agent.abort()` + slot holdUntil; registry/TUI publish `cancelled` immediately | Provider may stream briefly after dispose grace, but late completion cannot reopen the task |
| Nested slot deadlock | yield / reacquire / join yield | Logical hang on peer `message` can pin a slot until cancel |
| Handle clobber | Reject running/uncollected reuse + join `generation` | — |
| Worktree remove while writing | 1s quiescence; retain + async cleanup if non-cooperative | Best-effort prune leftovers |
| Multi-session slot contention | Documented process-wide budget | Sessions starve each other in one process |

---

## 5. Concurrency, parallel, fanout, worktrees (context)

### Slots

- Module-global `active` / `waiters` (process-wide, not per session).
- Queue reject when full (except lease reacquire, which bypasses queue cap).
- Concurrent descendants of one parent use ref-counted yield so the first finishing child
  does not reacquire while a sibling still needs the free slot.

### Parallel

- `spawnAll`: allSettled semantics; one failure does not cancel siblings.
- Caller `concurrency` is **clamped** to `PIT_SUBAGENT_MAX_CONCURRENCY` so batches queue
  inside the worker pool instead of dying with “subagent queue full”.
- Per-task model / thinking / tools / schema / acceptance / cache-key label.
- **No** `worktree` field on `ParallelTask` (only single `task` options expose it).

### Fanout

- Pipeline: scout (structured `targets`, max 32) → N reviewers (`{{target}}` safe
  substitution) → worker (optional acceptance).
- Review synthesis capped (32KB head+tail); usage merged for spend; digests + `op:read`
  recovery aligned with N7.
- Scout failure throws; reviewers are allSettled; **worker always runs**, even with zero
  targets or all reviews failed.
- Depth quirk: reviewers spawn at `childDepth + 1` while scout/worker use `childDepth`.
  With default `PIT_SUBAGENT_MAX_DEPTH=1` all stages lack nested coordinator tools;
  with higher depth the asymmetry matters.

### Worktrees

**Strengths:** rebuild cwd-sensitive native tools; strip coordinator + `code`; managed-path
`rm` only; partial-create cleanup; plan/ask block create; session-aware rebind preserves
shell/search options when wired from `AgentSession`.

**Limits (documented, still real):**

- Isolation is **native-tool-centric**. MCP / extension / chrome tools keep host bindings;
  absolute parent paths still work if the model passes them.
- Agent slots limit concurrent Agents, not concurrent full checkouts under
  `.pit/worktrees/`.
- `cleanup: "auto"` runs are not resumable/continuable.
- Non-git cwd cannot use worktree isolation.

---

## 6. Resume, output recovery, budget, observability (context)

### Resume / continue durability

| Path | Survival | Mechanism |
|------|----------|-----------|
| Resume Tier-1 | Same session | Live Agent in `resumable` map (FIFO 8) |
| Resume Tier-2 | Process restart | `.pit/subagents/<stem>.json` under cwd |
| Continue | Same session only | Live Agent in `continuable` map (FIFO 8) |

- Interrupted runs: mark resumable + await disk save before tool result returns.
- Per completed turn (non-auto-worktree): serialized checkpoint rewrite.
- Concurrent resume deduped (`resumeInFlight`); continue/resume share lifecycle lock.
- Success: leave resumable, enter continuable, delete disk file.
- Re-error/cancel: keep/rewrite disk (do not delete on failed disk resume).
- Continue has **no** Tier-2: restart kills all continuable Agents.
- Continuable FIFO drop is total loss of follow-up; resumable FIFO drop still has disk.

### Output digest vs integral (N7)

```
Parent context  ← head+tail digest (default 4KB) + pointer task({op:"read", name})
Integral text   ← registry.output (in-session) + SubagentOutputStore (session temp)
```

- Store: opaque files, cap 256 entries / 16MB session, redacted, dispose wipes temp dir.
- `op:read` prefers registry, else store; tool wrap still applies ~**96KB** head+tail.
- Hardening design asked for **bounded paging**; not implemented. Calling recovery
  “integral” is accurate only when full text ≤ wrap cap and the session store still holds it.
- After session dispose / process restart: integral outputs are gone (temp + registry).
  Resume transcripts survive; outputs do not.

### Token budget

| Operation | Pre-gate reserve | Post-charge |
|-----------|------------------|-------------|
| `run` / `spawn` / parallel / fanout | Yes | Yes |
| Disk `resumeFromDisk` | Yes | Yes |
| In-memory resume | **No** | Delta-only on appended turns |
| Continue | **No** | Delta-only |

Unified ledger (`TokenBudgetGovernor`) channels main / subagent / fusion; goal mirrors
`tokenSpendSplit` on reload (K7 / K9b). Tier-1 re-drives correctly avoid double-counting
prior turns, but can overshoot the goal until settlement because they skip reservation.

### Observability today

**Present:** `op:list` (registry lines, async, resumable, continuable, slots, sum tokens);
hooks `onSubagentStart` / progress / complete / async complete; registry turnCount + usage;
manifest fields on `SubagentRecord`.

**Thin:** list omits costUsd, model, depth, worktree, partial/manifest, denied tools;
resume/continue complete meta often empty; no governor remaining/reserved on list;
silent FIFO drop of continuable; silent store/checkpoint I/O failure; list mojibake on
evicted line (`evicted â€”`).

---

## 7. Safety model (permissions + guards)

### Layers parent → child

| Layer | Where | Role |
|-------|--------|------|
| Parent permission gate | permissions-extension + session recheck | Every parent tool call |
| Child permission gate | `spawn.ts` `beforeToolCall` | Same `PermissionChecker` |
| Mutation policy | optional `policy` on `task` | Paths / tests / assertions / timeouts |
| Guard chain | `createSubagentGuardChain` | Grounding + destructive + learned-error |
| Depth / catalog | `buildSubagentToolCatalog` | Strip/rebrand coordinator by depth |
| Worktree | spawn + retarget | Isolated checkout; blocked in plan/ask |

### Modes (short)

- **plan / ask:** host-trusted RO delegation only when effective child catalog is
  side-effect-free; no worktree; no acceptance; no default `message` tool; child inherits
  mode.
- **confirm:** spawn denied at terminal unless allowlisted; child maps confirm → deny
  (no UI).
- **auto:** shared deny floor + same checker chain as parent.

### Parent-only by design (not on subagent chain)

intent-gate · clarify-nudge · task-rigor · permissions extension as extension ·
patch-audit / impact · full MCP/hooks/memory host extensions.

### Mutation policy caveat

`SubagentMutationPolicy` applies only to tools with `mutationGuard: true` and a
`path` / `file` / `filePath` arg. **Bash is not covered** — policy is soft edit-tool
policy, not a filesystem sandbox.

### Doc drift (important)

| Source | Claim | Reality |
|--------|--------|---------|
| skill `modes-and-permissions.md` | no read-only carve-out for subagents | **Wrong** — `readOnlyDelegation` exists and is tested |
| Plan/Ask runtime prompts | no read-only carve-out for subagents | **Wrong and model-facing** — checker can authorize proven read-only delegation |
| `prevention-layers.md` learned-error row | propagated to subagents | **Correct in the current worktree**; the earlier “parent-only” finding is obsolete |
| `prevention-layers.md` / `already-built.md` plan-prompt placement | older `before_agent_start` / dynamic-suffix story | Stance moved to cacheable system-prompt prefix |

Canonical `permissions.md` / `subagents.md` mostly match the implementation. The
remaining contradiction is in the runtime Plan/Ask prompt text and secondary guidance.

---

## 8. Improvement opportunities (corrected classification)

The original H/M/L identifiers are retained for traceability; they are no longer the
source of priority. The authoritative classification below separates confirmed defects,
product decisions, measurement-dependent hypotheses, and rejected findings.

### High — confirmed and actionable

| ID | Finding | Evidence and correction |
|----|---------|-------------------------|
| H2 | Pre-reserve token budget on live resume / continue | Spawn, parallel, fanout, and disk resume reserve before work. Live resume/continue only post-charge deltas, so concurrent re-drives can temporarily exceed the goal. Apply the existing reserve/release/record contract and add a rejection test. |
| H3 | Honest large-output recovery | `op:read` obtains the full string but the tool wrapper returns at most ~96KB head+tail. Add paging/cursor support or stop advertising the returned payload as integral; document store limits and best-effort failure behavior. |
| H5 | Align model-facing prompts and secondary docs | The permission checker and tests allow host-proven read-only delegation, while the Plan/Ask runtime prompts and the skill reference say no carve-out exists. `already-built.md` and `prevention-layers.md` also retain the old prompt-placement story. The learned-error row in `prevention-layers.md` is already correct and is not part of this finding. |
| H6 | Diagnostics for silent retention/guard failures | Guards built with the shared guard helper already emit `guard.failed`; however, the outer subagent replay wrapper and best-effort output/resume/checkpoint I/O can still swallow failures. Emit diagnostics without changing fail-open or task-success semantics. |

### Medium — confirmed behavior worth correcting

| ID | Finding | Recommended scope |
|----|---------|-------------------|
| M4 | `op:list` exposes little operational context | Add only high-signal fields: cost, model, depth, worktree, partial/error state, and governor remaining/reserved. |
| M5 | Live resume/continue completion metadata is empty | Return the already-computed usage and turn delta to lifecycle/TUI callbacks. |
| M6 | FIFO eviction is silent | Emit a diagnostic or list marker when a live continuable/resumable Agent is evicted. |
| M7 | Mutation policy does not cover bash | Document it as edit-tool policy, not a sandbox. Bash hardening is separate and should not rely on naive command parsing. |
| M9 | Fanout reviewer depth is asymmetric | Reviewers use one extra depth level despite being launched by the same orchestrator as scout/worker. Document a rationale or align the depth and test nesting. |
| M12 | Thin safety-edge tests | Add direct Ask-mode worktree rejection, real-write `allowedPaths`, and exhausted-governor live-resume coverage. The public permission suite already covers successful read-only delegation in both Plan and Ask. |
| L8 | Queued runs are reported as running | Keep `pending` until the run slot is acquired, or explicitly expose a queued state. |

### Medium — optional product policy, not a defect

| ID | Opportunity | Boundary |
|----|-------------|----------|
| H1 | Optional aggregate task deadline | There is no total task deadline, but provider rounds already have idle/wall-clock watchdogs and a stalled call does not necessarily consume turns or tokens. Add `timeout_ms` only if long-lived slot pinning is an observed problem. |
| H4 | Fanout empty/all-failed review policy | The worker always runs after review synthesis. This is deterministic existing behavior; add `min_ok_reviews` or skip policy only if the product wants failure propagation instead. |

### Low / conditional

| ID | Opportunity | Classification correction |
|----|-------------|---------------------------|
| M1 | Stronger host-tool isolation in worktree mode | Documented hardening option, not a native-worktree bug. Requires a threat model; prompt discipline is not an OS sandbox. |
| M3 | Worktrees on parallel/fanout stages | New product capability with merge/cleanup complexity, not missing correctness. Fanout normally has one final writer. |
| M10 | Built-in explore type includes bash | Real tension, but bash is also useful for read-only inspection. Reword to “non-mutating bash” or design an enforceable safe-exec profile; blindly removing bash would regress exploration. |
| M11 | Document parent-only conditioning | Useful documentation polish for intent-gate, clarify, task-rigor, and patch-audit. |
| L1 | Fix list mojibake | Confirmed low-severity output defect (`evicted â€”`). |
| L3 | Configurable FIFO / TTL | Optional knob for long-lived hosts; fixed defaults are not a defect. |
| L5 | Multi-session slot fairness | The process-wide FIFO pool causes shared contention, not demonstrated starvation. If multi-session becomes first-class, preserve a global cap and add fairness rather than independent unbounded pools. |
| L6 | Durable continue / durable outputs | Optional Tier-2 product feature with storage, privacy, and retention costs. |
| L7 | Split the coordinator extension | Maintenance refactor only when active change pressure justifies it. |
| L9 | Clearer error for cancelling blocking runs | Blocking runs are cancelled through the parent turn signal by design; improve only the error message if models commonly confuse the two paths. |

### Resolved in the current worktree

| ID | Finding | Resolution |
|----|---------|------------|
| L2 | Distinguish cancelled async delivery | Detached cancellation emits `subagent_complete` with `cancelled` immediately; the live strip renders `cancelled`, and a late provider completion cannot reopen the task. |

### Measure before proposing

| ID | Hypothesis | Why it is not yet a finding |
|----|------------|-----------------------------|
| M2 | Separate worktree/disk concurrency cap | Four checkouts are possible, but no disk, lock-contention, or latency measurements demonstrate a bottleneck. Same-HEAD checkout reuse could weaken isolation and should not be the default recommendation. |
| L4 | Remove full output from terminal registry records | Memory impact is unmeasured. The output store is best-effort, bounded, session-temporary, and redacted; making it the sole source of truth could reduce recoverability or change semantics. |

### Corrected non-finding

| ID | Correction |
|----|------------|
| M8 | `cancel` wording and status semantics | **Corrected in the current worktree:** the response still says `cancellation requested`, while the detached handle/list transitions to `cancelled` immediately; provider settlement may lag. `details.cancelled` counts newly marked handles, not transport settlement. |

---

## 9. Residual risks (not obvious bugs)

| Risk | Mitigation today | Residual |
|------|------------------|----------|
| Long-lived task/slot | `max_turns`, cancel, Esc, per-round provider watchdogs; cancellation state is now visible before provider settlement | No aggregate task deadline (H1, conditional); a transport failure can still spend tokens during its bounded retry policy |
| Nested deadlock | lease yield | Peer messaging hang pins slot |
| Multi-session in one process | global FIFO budget | Cross-session contention; starvation not demonstrated (L5) |
| Worktree escape | native retarget + prompt | MCP/host tools (M1) |
| Continue loss | FIFO 8 | Silent; no Tier-2 (M6, L6) |
| “Integral” output | store + `op:read` | 96KB wrap; gone after dispose (H3) |
| Budget overshoot on re-drive | post-charge deltas | No pre-reserve (H2) |
| Wrong delegation model | checker permits proven RO delegation | Plan/Ask runtime prompts and secondary docs deny it (H5) |

---

## 10. Test coverage map

### Well covered

| Area | Anchors |
|------|---------|
| Spawn lifecycle, turn cap, partial, onSettle | `coordinator-spawn.test.ts`, subscription tests |
| Slots / nested deadlock / join yield | `coordinator-slots.test.ts` |
| Worktree create/cleanup/abort/partial | `coordinator-worktree*.test.ts` |
| Resume live + disk + failed rewrite | `coordinator-resume*.test.ts` |
| Continue accounting | `coordinator-continue.test.ts` |
| Parallel / fanout / parity digests | `coordinator-parallel|fanout|parity.test.ts` |
| Output digest + read | `coordinator-output-*.test.ts` |
| Plan/ask RO delegation | `permissions-readonly-delegation.test.ts` |
| Confirm → deny | `permissions-confirm.test.ts` |
| Guard chain order / opt-out | `subagent-guards.test.ts` |
| Depth / agent types / model | `coordinator-depth|agent-types|model.test.ts` |

### Thin / missing

| Area | Gap |
|------|-----|
| Ask-mode worktree block | Plan asserted; ask thin |
| Mutation policy on real write | Unit on evaluator only |
| Policy vs bash escape | Uncovered by design |
| Outer subagent replay/store failure diagnostics | Shared guards emit `guard.failed`; wrapper and retention I/O gaps remain unasserted |
| Live resume budget reject | Not asserted |
| Fanout skip-worker policy | N/A until H4 |
| Paging on `op:read` | N/A until H3 |
| Parent-only invariants on child | Implicit only |

---

## 11. Recommended packaging if implementing later

Not a commitment — a sensible order if product prioritizes residual risk:

1. **Truth pack:** H5 runtime-prompt/secondary-doc alignment + H3 paging/contract honesty.
2. **Budget and diagnostics pack:** H2 pre-reserve + H6 diagnostics.
3. **Observability pack:** M4 + M5 + M6 + L1 + L8. (L2 is resolved in the current worktree.)
4. **Fanout consistency pack:** M9 depth semantics + tests; H4 only after a product decision.
5. **Conditional hardening:** H1, M1, M2, M3, and M10 only after threat-model, usage, or performance evidence.

Avoid: second coordinator, reimplementing slots, or “add resume / digests / concurrency”
as greenfield work — those already ship.

---

## 12. Conclusion

**There is room for improvement, but not as “immature layer.”**

- **Do not rewrite** spawn / slots / resume core — they encode hard-won contracts
  (leases, generation, partial, Tier-2, RO proof).
- **Do improve first** budget symmetry, recovery honesty, model-facing prompt truth,
  retention diagnostics, and targeted observability.
- **Measure before adding** aggregate task deadlines, worktree-specific schedulers,
  registry storage redesigns, or broader fanout/worktree surfaces.

For a coding-agent CLI, this is a broad subagent surface (async ops, disk resume,
acceptance, worktrees, budget, Plan/Ask RO proof). The source and focused tests support
the maturity assessment; production readiness still requires workload and failure-mode
evidence. Residual value is **operational and product**, not “make the basics exist.”

---

## 13. Addendum (pass 2 — corrected disposition)

A second review surfaced four candidate deltas. Direct revalidation confirmed the
behavior behind A1, rejected A2/A3 as defects, and downgraded A4 to non-actionable
duplication.

#### A1 — Judge spawn failure aborts acceptance — partially valid policy question

- **Context:** In `runWithAcceptance`, if the judge subagent *throws* (schema
  rejection on a malformed verdict, or a provider/auth error mid-judge) the error is
  re-thrown through the per-attempt `catch` (`acceptance.ts:434-441`) and the outer
  `catch` (`acceptance.ts:448-459`), aborting the whole acceptance. Only the
  `value === undefined` case degrades gracefully to a failed gate
  (`acceptance.ts:215-221`). A flaky judge therefore costs the entire worker spawn
  instead of counting as one failed attempt (retry → exhaustion).
- **Correction:** the behavior is real, but treating every judge throw as `pass:false`
  would incorrectly retry cancellation, provider/auth, and other infrastructure
  failures. First classify retryable verdict/parse failures separately; only those may
  participate in gate retry/exhaustion. Until that taxonomy exists, this is not an
  implementation-ready defect.

#### A2 — Cache-read tokens consume the goal budget — rejected

- **Correction:** inclusive goal accounting intentionally counts
  `input + output + cacheRead + cacheWrite`. Cache reads may be cheaper than ordinary
  input, but they are not generally free and still represent consumed provider/context
  tokens. Excluding them would undercount the documented token budget. If a monetary
  ceiling is wanted, add a separate cost budget rather than changing token semantics.

#### A3 — Live ledger vs charged-cost mismatch on acceptance — rejected as stated

- **Correction:** worker and judge already create separate registry/lifecycle records.
  The acceptance aggregate equals the sum of those records, and the main task result
  exposes the aggregate cost charged to the governor. There is no demonstrated ledger
  mismatch. A UI may group worker/judge attribution more clearly, but recording or
  charging both again risks double-counting.

#### A4 — `safeNotify` duplicated verbatim — non-actionable hygiene

- **Correction:** the small helper is duplicated in two modules, but no drift or defect
  is demonstrated. Extract only if a third use or an actual behavioral divergence
  appears; a shared abstraction now would not materially improve the layer.

---

## Incident follow-up (2026-08-07)

Two production symptoms were separated from the review’s earlier opportunity list:

- An invalid `gpt-luna` alias is a caller/configuration error, not a Luna model
  failure. Model resolution now keeps failing closed and, when the match is unique,
  suggests `openai-codex/gpt-5.6-luna`.
- A detached subagent could remain visibly `running` after cancellation while the
  provider/WebSocket promise was still unwinding. The coordinator now marks the
  pending handle and canonical registry record `cancelled` immediately, emits one
  terminal lifecycle event, and lets any late provider result lose to cancellation.
  `join` cancellation remains intentionally non-destructive: it stops waiting but
  does not kill the detached child.

The three WebSocket failures remain transport failures. Existing provider retry,
idle-watchdog, and fallback paths handle them; the incident does not prove that the
model was unable to analyze the repository. The observed token spend does justify
keeping scope discipline and aggregate-deadline/token-budget controls as measured
operational work, but it is not evidence for a structural coordinator rewrite.

## Changelog of this document

| Date | Note |
|------|------|
| 2026-08-07 | Initial read-only audit (parallel explore agents + direct code review). No code changes. |
| 2026-08-07 | Pass 2 addendum (A1 judge-fatal, A2 cache-read-in-goal, A3 ledger-cost mismatch, A4 safeNotify dup). Read-only. |
| 2026-08-07 | Revalidated against the current worktree: corrected priorities, rejected A2/A3, downgraded A4/M8, updated H5, and separated defects from product/measurement candidates. Documentation only. |
| 2026-08-07 | Incident follow-up: documented immediate detached-cancellation publication, canonical model-alias diagnostics, and the non-finding status of the observed WebSocket transport failures. |
