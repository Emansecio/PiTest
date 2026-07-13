# Prevention layers — how the Pit catches model errors

> Companion to [`already-built.md`](already-built.md).
> Read this before proposing a new guard/validation: it shows the layered pipeline that
> already wraps every model turn and every tool call, **in execution order**, so you can
> see where an error is caught — and not re-propose a layer that exists.
> Per-layer audit findings and the improvement backlog live in
> [`prevention-layers-audit.md`](prevention-layers-audit.md).

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
| compaction / pre-send overflow guard | before send | keeps context under the window; summarizes + prunes. The presend phase fires at `assembled > window * 0.95` (`PRESEND_OVERFLOW_RATIO`) and **re-estimates after awaiting any in-flight background compaction** so it never double-compacts; opt out `PIT_NO_PRESEND_OVERFLOW_GUARD=1` | `core/compaction/`, `agent-session-compaction.ts:44,483` |
| thinking cap | before send (compaction serialize) | trims stale assistant thinking blocks beyond the protected recent turns to head+tail (~1.5k chars) so old reasoning stops paying rent; opt out `PIT_NO_THINKING_CAP=1` | `capThinkingForContext` in `core/compaction/utils.ts`, applied `core/compaction/compaction.ts:1351` |
| overthink guard | during stream | live thinking-delta tracker: one contiguous reasoning block past the per-model-tier token threshold (weak ~1000 / frontier ~2500) without a tool call aborts the stream and injects a reminder; max 2 retries/turn; `watchTextDelta` counts plain-text reasoning for open models; opt out `PIT_NO_OVERTHINK_GUARD=1` | `packages/agent/src/overthink-guard.ts`, `core/overthink-policy.ts` |
| system-prompt build | before send | lean + conditional; volatile data kept in the suffix after `SYSTEM_PROMPT_DYNAMIC_MARKER`, out of the cached prefix. A custom prompt that omits the marker (or puts it at offset 0) triggers a warn-once `quality.cache-marker` diagnostic (`_checkDynamicMarkerPresence`) | `core/system-prompt.ts`, `packages/ai/src/types.ts` |
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
4. **validateToolArguments** (`:1114`) — TypeBox schema validation + primitive coercion + extra-key "Did you mean"; the echoed payload is capped (`packages/ai/src/utils/validation.ts`). Before coercion, **`stripNullishOptionalArgs`** drops optional fields whose value is a misplaced `null`/`{}` placeholder (a weak-model habit) so they are omitted rather than coerced to `""`/`0` — conservative: required keys and fields that legitimately accept null/object are left intact. **`coerceJsonStringArrays`** then parses a JSON-stringified array sent for an `array`-typed field (parity with the MCP loose-schema path, for ALL tools incl. built-ins); it skips fields that also accept `string`.
5. **beforeToolCall / `tool_call` hooks** (`:1115`) — the **guard firewall**. Can BLOCK or auto-fix args; later handlers see earlier mutations. After the firewall, args are **re-validated only when a handler mutated them** — invalid post-mutation args short-circuit with an actionable error instead of reaching execution (`agent-loop.ts` `prepareToolCall`). Members **in registration order** (`core/built-ins/index.ts` + `grounding-guard-registry.ts` — this order is what a new guard must assume):
   1. **permissions** — gate by permission mode.
   2. **read-guard** — must `read` a file before editing it.
   3. **edit-precondition** — file unchanged since last read (mtime); dry-run `computeEditsDiff` before execution.
   4. **learned-error-guard** — block a call whose exact args failed repeatedly in prior sessions (inserted between edit-precondition and the grounding chain; parent-only, not propagated to subagents).
   5. **grounding firewall** (coordinated by `grounding-fire-once`): **symbol → import → erasable-syntax → path → pattern → bash** — pre-exec verification of symbols, imports, paths, regex/globs, and `npm/pnpm/yarn run` scripts against the real tree; auto-fix-or-block with fuzzy candidates. The **erasable-syntax-precondition** (tsgo `erasableSyntaxOnly` preflight: no enum/namespace/param-properties reaches disk) runs *inside* this chain, between import- and path-grounding. Bash-grounding's per-session scripts cache is **invalidated when a successful mutating call touches any `package.json`**, so a script the model just added grounds against the fresh manifest.
   6. **destructive-command-guard** — quote-aware **fire-once speed bump** for the middle tier of destruction (`rm -rf ./src`, `git reset --hard`, `git clean -fd`, `git push --force`, PowerShell/cmd `Remove-Item -Recurse/-Force`, `rd /s`, `del /s`, glob `Clear-Content`): blocks once with an impact note; **re-issuing the same command confirms and runs it**. A destructive-shaped segment whose target hides behind command substitution (`$(…)`, backticks) or an `eval`/`bash -c` wrapper is block-once too — the guard flags the opacity instead of trying to expand it. It is NOT a hard block — the catastrophic tier (`/`, `~`, drive roots incl. the PowerShell/cmd forms) is hard-blocked by the permission deny-floor (`BUILTIN_DANGEROUS_COMMANDS`) instead. Runs LAST, after all grounding guards.

## Band C — After a tool runs (CORRECTIVE — these catch/repair)
1. **Tool-error-hint enrichment** (`agent-loop.ts:1221`, Tier 4) — runs **before** `afterToolCall` so a host override sees the enriched content. Appends recovery hints to error results (`core/tool-error-hint-rules.ts`): bash/read/edit/**edit_v2**, hashline-anchor-stale, ENOENT/path/permission/read-guard, navigation "Did you mean". Every fire emits a `hint.fired` diagnostic with its stable rule id; `HintFireTally` aggregates a per-rule count into the session summary (`hintFires`) so dead/noisy rules are measurable.
   - **Repair Node** (success-path counterpart, `core/tool-repair-note.ts`): when a **successful** call's args were silently auto-repaired (key alias, type coercion, array-from-string), appends a one-line `[repair]` note describing the fix so a weaker model emits the canonical shape next turn. **Auto-gated per current model** by `core/repair-note-policy.ts` (ON for weak/open providers, OFF for native frontier anthropic/google/openai/openai-codex), re-evaluated each run; `PIT_TOOL_REPAIR_NOTE=1/0` forces it. Compares what the model sent vs what actually ran (`buildRepairNote`).
2. **afterToolCall / `tool_result` hooks** (`:1262`) — can rewrite the result:
   - **patch-audit** — audits edit/write diffs.
   - **read-guard** — records file mtime post-read (feeds edit-precondition).
3. **Verification gate** (turn end, `core/verification/verification.ts` + `_runVerificationGate` in `agent-session.ts`) — the heaviest corrective layer: a successful write/edit/edit_v2/ast_edit **arms** the gate (`armVerificationGate`, `agent-session-tool-end.ts`); after the turn ends, the session runs the project's check command (auto-detected: check → typecheck → lint → test scripts, falling back to local `tsc --noEmit`, then syntax-only checks on touched files). A failure is re-injected as a fix prompt for up to `verification.maxAttempts` rounds (recovery-adjusted, `agent-session.ts:3289`); when exhausted, a terminal message forbids reporting the task as done. Failures also feed `upsertLearnedErrorOnFailure`.
4. **Pending-checks drain** (`core/verification/pending-checks.ts`, `_awaitPendingChecksBeforeHandoff` in `agent-session.ts`) — background verification-class bash jobs are tracked and drained before handoff, independent of `verification.enabled`: a still-running check blocks "done", a failed one is re-injected for fixes.

## Band D — Session / turn lifecycle
- **before_agent_start**: task-rigor, clarify-nudge, mcp connect.
  - **clarify-nudge** (`core/clarify-nudge.ts` + `built-ins/clarify-nudge-extension.ts`): when a mutating prompt (rigor ≥2) is short (<160 chars) AND anchor-less (no path/extension/backtick/symbol/URL) and an interactive answer surface is bound (UserInputBus listener — never in print/CI/subagents), appends a `<clarify_first>` directive: the model may ask the user up to 3 targeted questions via the `ask` tool in ONE round before its first mutating action, must not ask what the codebase can answer, and proceeds without asking when the request is clear. Nudge-only (never blocks), parent-only, fail-open; telemetry `quality.clarify`; opt out `PIT_NO_CLARIFY_GATE=1`.
- **turn_start**: edit-precondition reset.
- **session_before_compact**: `read-guard` clear, `ReadDedupeStore.clear()`, hooks.
- **session_start / session_shutdown**: permissions, mcp, hooks.
- **Cross-cutting steering** (reminders, not blockers): doom-loop, stagnation, todo-cadence, failure-budget (per-turn cap with optional cross-turn carryover via half-life decay; opt out `toolFeedback.failureBudget.carryover: false`) — nudge the model without vetoing.
- **Session Recovery** (`session-recovery.ts` + `TurnSteeringEngine`): reactive scaffolding uplift. Every session starts **`lean`** (behavior-identical to the historical harness). When thrash signals fire (doom-loop tiers, result-loop, cross-error, failure-budget, repeating-pattern, verification exhausted, stagnation hard), the level rises **`guided` → `strict`**, enabling: error-reflection via **steer** (not stale `followUp`), tighter loop thresholds, +1/+2 verify `maxAttempts`, one-shot narration steer. Clean tool-success streaks de-escalate. **Not** model-tier classification — opt out `PIT_NO_SESSION_RECOVERY=1`. Telemetry: `quality.recovery`; the TUI footer shows a `recovery:<level>` chip at `guided`/`strict` (repainted live via `setRecoveryLevelChangeListener`).

## Band P — pre-generation conditioning (ALL PILLARS ACTIVE)

> **Status: fully shipped 2026-07-03.** Design, decisions and rationale live in
> [`conditioning-band-study.md`](conditioning-band-study.md). Every pillar is dosed by
> the supervision thermostat level and has an individual kill-switch:
> `PIT_NO_SUPERVISION_THERMOSTAT`, `PIT_NO_TELEMETRY_SINK`, `PIT_NO_CONTEXT_COMPOSER`,
> `PIT_NO_STYLE_EXEMPLAR`, `PIT_NO_INTENT_GATE`, `PIT_NO_SELF_REVIEW`,
> `PIT_NO_SESSION_CONTRACT`.

Where every band above reacts (validate the call, repair the result, correct the
behavior), Band P shapes what the model sees and intends BEFORE it generates:

- **P0 — supervision thermostat + efficacy telemetry** (the dosing source — no longer
  observe-only: P1-P4 consume the level):
  per-session supervision level (`assistido → padrao → leve`) earned by the model's
  observed output signals (guard blocks via the diagnostics channel, recovery thrash
  signals), with the three anti-oscillation locks: asymmetric hysteresis (tighten on
  one signal, loosen after a 5-clean streak), loosening gated to task boundaries
  (`quality.rigor` per-prompt marker), per-session reset. No cross-session
  self-regulation, no model lists to maintain — only fixed prior: native
  `anthropic`/`openai` start `leve`. **Nothing consumes the level yet**; transitions
  are emitted as `quality.supervision` diagnostics. `core/supervision-thermostat.ts`
  (instantiated by `SessionRecoveryController`); opt out
  `PIT_NO_SUPERVISION_THERMOSTAT=1`.
  Telemetry: every diagnostic is persisted timestamped to
  `<agentDir>/diagnostics/<sessionId>.jsonl` (`core/telemetry/diagnostics-sink.ts`,
  learned-error-store file pattern, opt out `PIT_NO_TELEMETRY_SINK=1`), a
  guard-fired→next-call-outcome correlator writes per-rule efficacy records
  (`core/telemetry/guard-efficacy.ts`), a session summary (recovery snapshot,
  verification tallies, cache stats) lands at dispose, and every `guard.*` emission
  carries a stable `ruleId` + `outcome` ("blocked"/"overridden"). The intent gate's
  procedural `intent-gate-no-plan` block deliberately does NOT tighten the thermostat
  (its `intent-gate-plan-findings` — a hallucinated path in a plan — does).
- **P1 — ground-truth injection** (`core/conditioning/context-composer.ts`): layered
  relevance predictor (prompt paths/symbols → imports of the last-read file → session
  hot files) renders a `<grounded_context>` block — real top-level declarations with
  kind+line from the enriched living repo-map — into the system-prompt dynamic suffix
  (cache-neutral), token-capped by thermostat level (1200/800/400).
- **P2 — intent gate** (`core/intent-gate.ts` + `built-ins/intent-gate-extension.ts`,
  in the firewall between learned-error and the grounding chain): risky prompts
  (task-rigor) require a `plan`-tool micro-plan validated against the real tree
  (`groundPath` + repo-map symbol set, fuzzy candidates on findings) before the first
  mutating call — blocks at protected levels (with an anti-lock degrade after 2
  blocks/cycle), nudges at `leve`.
- **P3 — exemplar anchoring** (inside the context composer): a `<style_exemplar>`
  block with the head of the best same-directory/same-suffix neighbor of the file
  being edited; `assistido`/`padrao` only, counted inside the P1 cap.
- **P4 — structured self-review** (`core/self-review.ts` + `core/turn-risk.ts`):
  per-cycle changed-line aggregate closes the many-small-edits gap; HIGH risk (any
  level) or MEDIUM (at `assistido`) runs a read-only review subagent (schema-bound,
  fusion-verify pattern) after the check phase, sharing the verification fix budget;
  unresolved high findings re-inject fix prompts and block `goal_complete` (R9).
- **P5 — conventions contract** (`core/session-contract.ts`): failed checks parsed
  (biome rule ids, recurring TS codes, TS1294 special-case) into ≤5 standing session
  constraints rendered as `<session_contract>` in the dynamic suffix; a constraint
  expires after 3 consecutive verification passes without re-firing.

---

## How to use this map
- **Proposing a new check?** Place it in the right band first. A "validate args" idea → Band B already has rewrite + TypeBox. A "block dangerous X" → Band B firewall. A "warn after the fact" → Band C. A "run the tests/typecheck after edits" idea → Band C verification gate + pending-checks already do exactly that. If a band already covers it, the valuable move is to *strengthen the existing layer*, not add a parallel one.
- **Ordering is load-bearing.** In Band B, rewrite runs before validation, validation before the firewall, and firewall handlers run in registration order. If a handler mutates args, a conditional post-firewall re-validation runs before execution — a new `tool_call` guard must assume earlier guards may have already rewritten the args.
- **Preventive vs corrective.** Band B stops the error before it happens (cheapest); Band C only repairs after. Prefer adding prevention in B over detection in C when both are possible.

See the broader inventory in [`already-built.md`](already-built.md).
