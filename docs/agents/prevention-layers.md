# Prevention layers — how the Pit catches model errors

> Companion to [`already-built.md`](already-built.md) and the root [`AGENTS.md`](../../AGENTS.md).
> Read this before proposing a new guard/validation: it shows the layered pipeline that
> already wraps every model turn and every tool call, **in execution order**, so you can
> see where an error is caught — and not re-propose a layer that exists.

The Pit defends against model mistakes in **four bands**: around the model (per turn),
**before** a tool runs (preventive — these block the wrong call), **after** a tool runs
(corrective — these catch/repair), and across the session lifecycle. The per-tool-call
ordering is fixed in `packages/agent/src/agent-loop.ts`; the guards themselves are wired
extensions in `packages/coding-agent/src/core/built-ins/`.

---

## Band A — Around the model (per turn)
Applied before/while talking to the model, not per tool call.

| layer | when | what | anchor |
|-|-|-|-|
| transformContext | before send | last hook to mutate the message list before the model sees it | `agent-loop.ts:497` |
| compaction / pre-send overflow guard | before send | keeps context under the window; summarizes + prunes | `core/compaction/`, `_checkCompaction` (agent-session) |
| system-prompt build | before send | lean + conditional; volatile data kept in the suffix after `SYSTEM_PROMPT_DYNAMIC_MARKER`, out of the cached prefix | `core/system-prompt.ts`, `packages/ai/src/types.ts` |
| plan-mode prompt | before send (`before_agent_start`) | while permission mode is `plan`, the permissions extension appends a `<plan_mode>` section telling the model it is read-only and must research → build a DAG → call `exit_plan`; never invalidates the cached prefix | `core/built-ins/permissions-extension.ts`, `core/permissions/plan-mode-prompt.ts` |
| prompt cache breakpoints | on send | 4 Anthropic breakpoints + stable OpenAI `prompt_cache_key` | `packages/ai/src/providers/anthropic.ts` |
| connect-guard | during connect | connect-phase timeout + instant abort (anti-wedge) | `packages/ai/src/utils/connect-guard.ts` |
| idle-timeout | during stream | stalled-body watchdog, retryable | `packages/ai/src/utils/idle-timeout.ts` |
| TTSR matcher | during stream | interrupts the stream when output matches a stop rule (`ttsrMatcher`) | `agent-loop.ts` |

## Band B — Before a tool runs (PREVENTIVE — these can block the wrong call)
Fixed order inside `prepareSingleToolCall` (`agent-loop.ts:1066+`). Each step can short-circuit with an actionable error so the model recovers in one round-trip, never executing the wrong call.

1. **Unknown-tool guard** (`agent-loop.ts:1067`) — invalid tool name → error + closest-tool suggestion.
2. **prepareArguments** (`:1077`) — per-tool alias/path normalization (`~`/`@` expand, `:line` strip, JSON-string edit coercion). For **MCP/loose-schema** tools, `prepareArgsForLooseSchema` (`core/tools/argument-prep.ts`) is **schema-aware**: alias→canonical only when the server's own schema declares the canonical, JSON-string→array only for `array`-typed fields, and it drops optional `null`/`{}` placeholders the schema rejects (see `stripNullishOptionalArgs` below).
3. **Tool-rewrite registry** (`:1085`) — `auto` rules silently rewrite args; `suggest`/`block` reject with an actionable error (`skipHints`).
4. **validateToolArguments** (`:1114`) — TypeBox schema validation + primitive coercion + extra-key "Did you mean"; the echoed payload is capped (`packages/ai/src/utils/validation.ts`). Before coercion, **`stripNullishOptionalArgs`** drops optional fields whose value is a misplaced `null`/`{}` placeholder (a weak-model habit) so they are omitted rather than coerced to `""`/`0` — conservative: required keys and fields that legitimately accept null/object are left intact.
5. **beforeToolCall / `tool_call` hooks** (`:1115`) — the **guard firewall**. Can BLOCK or auto-fix args; later handlers see earlier mutations. After the firewall, args are **re-validated only when a handler mutated them** — invalid post-mutation args short-circuit with an actionable error instead of reaching execution (`agent-loop.ts` `prepareToolCall`). Members (`core/built-ins/`):
   - **permissions** — gate by permission mode.
   - **read-guard** — must `read` a file before editing it.
   - **edit-precondition** — file unchanged since last read (mtime).
   - **erasable-syntax-precondition** — tsgo `erasableSyntaxOnly` preflight on edits (no enum/namespace/param-properties/etc reaches disk).
   - **destructive-command-guard** — quote-aware dangerous-bash block.
   - **grounding firewall** (coordinated by `grounding-fire-once`): **symbol / import / path / pattern / bash** grounding — pre-exec verification of symbols, imports, paths, regex/globs, and commands against the real tree; auto-fix-or-block with fuzzy candidates.
   - **learned-error-guard** — block a call that repeats a known past failure this session.

## Band C — After a tool runs (CORRECTIVE — these catch/repair)
1. **Tool-error-hint enrichment** (`agent-loop.ts:1221`, Tier 4) — runs **before** `afterToolCall` so a host override sees the enriched content. Appends recovery hints to error results (`core/tool-error-hint-rules.ts`): bash/read/edit/**edit_v2**, hashline-anchor-stale, ENOENT/path/permission/read-guard, navigation "Did you mean".
   - **Repair Node** (success-path counterpart, `core/tool-repair-note.ts`): when a **successful** call's args were silently auto-repaired (key alias, type coercion, array-from-string), appends a one-line `[repair]` note describing the fix so a weaker model emits the canonical shape next turn. **Auto-gated per current model** by `core/repair-note-policy.ts` (ON for weak/open providers, OFF for native frontier anthropic/google/openai/openai-codex), re-evaluated each run; `PIT_TOOL_REPAIR_NOTE=1/0` forces it. Compares what the model sent vs what actually ran (`buildRepairNote`).
2. **afterToolCall / `tool_result` hooks** (`:1262`) — can rewrite the result:
   - **patch-audit** — audits edit/write diffs.
   - **read-guard** — records file mtime post-read (feeds edit-precondition).

## Band D — Session / turn lifecycle
- **before_agent_start**: task-rigor, mcp connect.
- **turn_start**: edit-precondition reset.
- **session_before_compact**: `read-guard` clear, `ReadDedupeStore.clear()`, hooks.
- **session_start / session_shutdown**: permissions, mcp, hooks.
- **Cross-cutting steering** (reminders, not blockers): doom-loop, stagnation, todo-cadence, failure-budget (per-turn cap with optional cross-turn carryover via half-life decay; opt out `toolFeedback.failureBudget.carryover: false`) — nudge the model without vetoing.
- **Session Recovery** (`session-recovery.ts` + `TurnSteeringEngine`): reactive scaffolding uplift. Every session starts **`lean`** (behavior-identical to the historical harness). When thrash signals fire (doom-loop tiers, result-loop, cross-error, failure-budget, repeating-pattern, verification exhausted, stagnation hard), the level rises **`guided` → `strict`**, enabling: error-reflection via **steer** (not stale `followUp`), tighter loop thresholds, +1/+2 verify `maxAttempts`, one-shot narration steer. Clean tool-success streaks de-escalate. **Not** model-tier classification — opt out `PIT_NO_SESSION_RECOVERY=1`. Telemetry: `quality.recovery`.

---

## How to use this map
- **Proposing a new check?** Place it in the right band first. A "validate args" idea → Band B already has rewrite + TypeBox. A "block dangerous X" → Band B firewall. A "warn after the fact" → Band C. If a band already covers it, the valuable move is to *strengthen the existing layer*, not add a parallel one.
- **Ordering is load-bearing.** In Band B, rewrite runs before validation, validation before the firewall, and firewall handlers run in registration order. If a handler mutates args, a conditional post-firewall re-validation runs before execution — a new `tool_call` guard must assume earlier guards may have already rewritten the args.
- **Preventive vs corrective.** Band B stops the error before it happens (cheapest); Band C only repairs after. Prefer adding prevention in B over detection in C when both are possible.

See the broader inventory in [`already-built.md`](already-built.md).
