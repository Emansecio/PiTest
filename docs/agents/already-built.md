# What the Pit already has — read this BEFORE proposing improvements

> Part of the canonical chain: source of truth is [`AGENTS.md`](../../AGENTS.md) (and
> [`CLAUDE.md`](../../CLAUDE.md) points there too). Companion: [`prevention-layers.md`](prevention-layers.md)
> maps the guard pipeline in execution order. Same rules whichever doc you entered through.

**Why this file exists.** Agents asked to "find improvements" overwhelmingly re-propose
things the Pit already ships: add caching, dedup tool output, truncate reads, retry on
rate-limit, a "did you mean" for typos, kill orphaned processes, an idle timeout… all
already built. That wastes a review and buries the few real opportunities.

**The rule.** Before proposing any improvement, confirm here that it does not already
exist. If it exists, either propose a concrete improvement *to it* (with `file:line`) or
move to **[Where the frontier actually is](#where-the-frontier-actually-is)** at the
bottom — that's where new value lives. A suggestion of the form "add «cache / dedup /
truncation / retry / guard / timeout» X" is almost certainly redundant; check first.

This is a curated map, not exhaustive API docs. Anchors are `file` or `file:symbol`;
open them to confirm before acting. Keep it updated when a subsystem lands.

---

## Token & context economy
The expensive, "obvious" wins are done. This subsystem is mature.

- **Prefix economy (K5)** — `tool-wire-schema.ts` (lazy wire schemas: compact descriptions + strip nested schema descriptions on provider wire; opt-out `PIT_NO_LAZY_TOOL_SCHEMAS`), `context-files.ts` (pointer dedupe AGENTS/CLAUDE E16, retrieval excerpt for large project context E6; opt-out `PIT_NO_CONTEXT_RETRIEVAL`), Anthropic/OpenAI-compat tools sorted by name with `cache_control` on first tool (E2).
- **Token budget governor (K7)** — `token-governor.ts`: unified ledger for main + subagent + fusion spend; drives `goal.tokensUsed` via `syncTokensUsed`, gates `task` spawn when goal budget is exhausted, exposes `budgetSpent`/`budgetLimit`/`subagentSpent`/`fusionSpent` on `getContextUsage()`. Fusion stages wired in `agent-session-fusion.ts` (panel members use char estimate).
- **CI token regression gate (K8/G12)** — `scripts/check-token-bench.mjs` compares `bench-session-tokens.mts` + `bench-prompt-size.mts` + `bench-fusion-tokens.mts` METRIC output against `scripts/baselines/token-economy.json`; runs in `npm run check`.
- **Mechanism METRIC breakdown (K9/G11)** — `bench-session-tokens.mts` emits per-mechanism `reclaimed_tokens` (thinking_cap, prune_tool_output, supersede, arg_elision) per scenario.
- **Goal token split persist (K9b)** — `GoalState.tokenSpendSplit` (main/subagent/fusion) saved with goal entries and restored into `TokenBudgetGovernor` on session reload.
- **Fusion token bench (K9/G4)** — `scripts/bench-fusion-tokens.mts` synthetic per-stage Fusion token model for regression gate.
- **Structured-primary summary (K8+K10/C2)** — JSON-primary summarizer (`STRUCTURED_SUMMARY_SCHEMA` → `formatStructuredSummaryMarkdown`) plus `trimSummaryProseAgainstOperations` for operation dedup. Opt-out `PIT_NO_STRUCTURED_SUMMARY_OUTPUT` / `PIT_NO_COMPACT_SUMMARY_OUTPUT`.
- **Memory/hindsight on-demand prefix (K10/E3+E4)** — `formatMemoryHintForPrompt` + `formatHindsightHintForPrompt` replace full-body inject; recall via `read()` / `recall()`. Opt-out `PIT_NO_MEMORY_ON_DEMAND` / `PIT_NO_HINDSIGHT_ON_DEMAND`.
- **Fusion panel economy (K10/F1+F2)** — `capPanelText` (`FUSION_PANEL_TEXT_MAX_CHARS=6000`) before judge/writer/verifier; `shouldSkipFusionVerify` when judge finds no `unsupportedClaims` (lone survivor still verifies).
- **Compaction / pruning** — `core/compaction/compaction.ts`. `pruneOldToolOutputs` already does: mutation-arg elision, head+tail excerpting of large outputs, **defer/recall to disk**, and **superseded-read collapse** (`buildSupersededToolResultIndices` for read/grep/find/ls/symbol). **Live economy (K3):** `applySupersedeOnly` below `proactivePruneFloor`, immediate supersede + arg elision after tool success (`agent-session-live-prune.ts`; opt-out `PIT_NO_LIVE_SUPERSEDE` / `PIT_NO_LIVE_ARG_ELISION`). **Thinking cap (K4):** `applyOldThinkingCap` on send path (`transformContext` → `_pruneContextForProvider`); stale assistant `thinking` blocks capped to 1500 chars head+tail via `capThinkingForContext` (`utils.ts`); recent turns protected; opt-out `PIT_NO_THINKING_CAP`. **Delta summarization (K6):** 2nd+ compact uses `serializeConversationDelta` (compact JSON in `<conversation-delta>`, omits thinking, tighter arg/result caps) instead of full prose `serializeConversation`; opt-out `PIT_NO_DELTA_SUMMARIZATION`. `adaptivePruneThreshold` tightens as the context window fills; `keepRecent` scales the protected recent window.
- **Read de-dup** — `core/tools/read.ts` `ReadDedupeStore`: suppresses an identical `(path,range)` re-read, sends a **delta** when the file changed, and `clear()`s on `session_before_compact` so post-compaction re-reads re-send in full.
- **Deferred tool output** — `recall_tool_output` tool + defer path (`PIT_NO_DEFER_HISTORY` opt-out): heavy outputs go to disk, recallable on demand.
- **Prompt cache** — 4 Anthropic cache breakpoints (tools / system-static / compaction-summary / last-user) in `packages/ai/src/providers/anthropic.ts`; stable `prompt_cache_key` for OpenAI. `SYSTEM_PROMPT_DYNAMIC_MARKER` (`packages/ai/src/types.ts`) keeps everything volatile (date, cwd, git branch, frequent-files, hot outlines) in the **suffix**, OUT of the cached prefix (`core/system-prompt.ts`).
- **Cache telemetry** — `_trackPrefixStability` (`core/agent-session.ts`, counts prefix rebuilds by reason) + usage-derived `computeCacheStats` (`core/cache-stats.ts`, `instabilityTurn`, surfaced in the TUI). Measurement is already instrumented.
- **Tool discovery** — hidden tools via `search_tool_bm25`: inactive tools are kept OUT of the prompt's tool schema until surfaced (`toolDiscovery`, default-ON).
- **Schema-error echo cap** — `packages/ai/src/utils/validation.ts` truncates long string values in the echoed args (keeps keys/hints).

## Tools (single registry)
- **`core/tools/index.ts` `TOOL_REGISTRY` is the single source of truth.** Built-ins: `read`, `edit`, `edit_v2` (content-hash/hashline), `write`, `bash`, `grep`, `find`, `ls`, `symbol`, `find_symbol`, `repo_map`, `ast_grep`, `ast_edit`, `code` (code-mode), `lsp`, `debug`, `web_search`, `chrome_devtools_*` (+`preview`), `calc`, `recipe`, `inspect_image`, `render_mermaid`, `todo`, `plan`, `ask`, `resolve`, `search_skills`, `search_tool_bm25`, `recall_tool_output`, `goal_complete`, and hindsight (`retain`/`recall`/`reflect`/`forget`).
- **Search backends are native + in-process**: `grep` has an optional **fff** warm-index backend (`core/tools/fff-search.ts`, default with rg fallback); `ast_grep` has **@ast-grep/napi** in-process (`core/tools/ast-grep-napi.ts`, default with CLI fallback). Don't propose "spawn rg/ast-grep faster" — the spawn is already bypassed.

## Quality guards (all shipped, `core/built-ins/`)
Each is a wired extension. Don't propose adding any of these:
- **read-guard** (must `read` before edit; clears on compaction) · **edit-precondition** · **grounding firewall**: symbol/import/path/pattern/bash (`grounding-guard`/`import-grounding`/`path-grounding`/`pattern-grounding`/`bash-grounding` + `grounding-fire-once`) — pre-exec grounding of symbols/imports/paths/regex/globs/commands · **task-rigor** · **permissions** · **learned-error-guard** · **erasable-syntax-precondition** (tsgo `erasableSyntaxOnly` preflight) · **destructive-command-guard** (quote-aware) · **patch-audit** · **coordinator** + **subagent-guards** (subagent orchestration & guard propagation) · **mcp** · **hooks** · **memory**.
- Loop/stagnation steering (doom-loop, stagnation, todo-cadence reminders) is wired in the session — don't propose "detect loops".

## Runtime robustness
- **idle-timeout** — `packages/ai/src/utils/idle-timeout.ts` (`raceReadWithIdle`, `iterateWithIdleTimeout`): stalled-stream watchdog on every provider; fire-and-forget teardown so abort/idle never wedges.
- **connect-guard** — `packages/ai/src/utils/connect-guard.ts`: connect-phase timeout + instant abort for openai-compat providers (the deepseek/opencode wedge fix). Body loop already covered by idle-timeout.
- **abort-race** — `core/utils/abort-race.ts` (`settleOrAbort`): unblocks hook boundaries on ESC.
- **atomic-write** — `core/utils/atomic-write.ts`: torn-write-safe writes (write/edit/settings/memory/resume).
- **killProcessTree** — `utils/shell.ts`: reaps the whole process tree on Windows/Unix (exec/eval-kernel/lsp/mcp/dap/**hooks**).
- Global `unhandledRejection` handler keeps the session alive; stdin EPIPE handled.

## Error recovery / self-correction
- **Tool-call argument repair** — the "Tool Repair Harness" idea is already a layered subsystem; don't re-propose "fix malformed tool args / coerce types / alias keys". Coverage:
  - **Key aliases** (`core/tools/argument-prep.ts`): `file_path`/`filepath`/`filename`/`file`→`path`, `old_string`/`oldString`/`old_str`→`oldText` (+`new_*`), `cmd`/`script`→`command`, `text`/`body`→`content`. Canonical always wins. MCP/custom tools use `prepareArgsForLooseSchema` — **schema-aware** (only rewrites when the server's own schema declares the canonical, never blindly).
  - **JSON-string→array** (`coerceJsonArrayField`): a stringified `["a"]` / `[{…}]` becomes the native array (built-ins + schema-typed `array` fields on MCP).
  - **Primitive coercion** (`packages/ai/src/utils/validation.ts`): string→number/integer/boolean, numeric-string union ordering (`"1"`→`1` not `true`), null→`""`/`0`/`false` for required fields.
  - **`null`/`{}` placeholder strip** (`stripNullishOptionalArgs`): optional fields set to `null` or empty-`{}` are **omitted** (the model's intent) rather than coerced — conservative (never required keys, never null-accepting/object-typed fields). Applied in `validateToolArguments` (built-ins/custom) and `prepareArgsForLooseSchema` (MCP).
  - **Tier-1 rewrite registry** (`core/tool-rewrite-rules.ts`): `read` offset/limit string→num, `start_line`/`end_line`→`offset`/`limit`, `path:"f:10-20"` range split, Windows shell normalization (`C:\`→`C:/`, `2>nul`, `/c/`). Plus `suggest` (bash→dedicated tool) and `block` (no-op edit, out-of-bounds read, `rm -rf /`) tiers.
  - **Extra-key "Did you mean"** (`suggestClosestN`, Levenshtein) when a key isn't an alias.
  - **Repair Node** (`core/tool-repair-note.ts` + `core/repair-note-policy.ts`): tells a weaker model *how* its args were repaired on the successful result so it self-corrects next turn. **Auto-gated per current model** — ON for weak/open providers (DeepSeek/Qwen/Kimi/GLM via OpenAI-compat), OFF for native frontier (anthropic/google/openai/openai-codex); re-evaluated each run so a `/model`/fallback switch flips it. `PIT_TOOL_REPAIR_NOTE=1/0` forces it.
  - **learned-error store + guard** (cross-session): persists recurring failure fingerprints and pre-emptively blocks a repeat call (`core/built-ins/learned-error-guard-extension.ts`) — goes beyond per-call repair into cross-session memory.
- **tool-error-hint-rules** — `core/tool-error-hint-rules.ts`: actionable hints per tool error (bash/read/edit/**edit_v2**), incl. hashline-anchor-stale and ENOENT/path/permission/read-guard recovery.
- **Navigation dead-ends recover**: `symbol` suggests the closest declaration ("Did you mean"); `lsp resolveSymbolColumn` points at the real line when the given line is stale (`core/lsp/utils.ts`).
- **Retry**: reason classification (`core/modes/interactive/retry-reason.ts`) labels the countdown (rate-limit/overload/network/timeout/server); auto-retry + **fallback chain** (downgrades model on rate-limit; `fallback_warning` surfaced — to stderr in `-p` text mode).

## Providers
- **MCP**: ~full parity with Claude Code — stdio / http-streamable / sse transports, resources/prompts, OAuth PKCE, `.mcp.json` scopes, glob permissions, `pit mcp` CLI.
- **OpenAI-compatible login** (`/login` URL+key+probe) + presets (zai/verboo); custom-URL providers persisted to `models.json` with `login:true`.
- Multi-provider: anthropic / openai (responses & completions) / google / openai-codex / opencode / openrouter / zai.

## Subagents / orchestration
- **coordinator** (`task` tool): spawn / `continue` / `resume` (survives restart via `.pit/subagents/`), curated agent types (`.pit/agents/*.md`), concurrency cap, per-turn observability, token accounting.

---

## What does NOT exist (don't propose fixes for vaporware)
- **Diff-limit extension** — ADR-0002 proposed, never implemented. No code.
- **scoped-models** — orphaned UI; the decision is to *remove* it, not extend it.
- **`pi-*` services** — `pi-autoresearch`, `pi-subagents`, `@tintinweb/pi-tasks` etc. are external npm packages, not Pit internals.

---

## Where the frontier actually is
Because the "basics" above are done, real value now lives in these angles — analyze from
here, not from the checklist above:

**Active roadmap:** [`docs/optimization/context-economy-inventory.md`](../optimization/context-economy-inventory.md) — ordem K1–K10, benches `bench-prompt-size` + `bench-session-tokens` + `bench-fusion-tokens` + gate `check-token-bench.mjs`. Não re-propor itens marcados REMOVED ou já cobertos acima.

1. **Measure, don't estimate.** The economy infra exists but is rarely *measured* on a real session. The high-value work is proving a gain/regression with numbers (`bench/` + `scripts/bench-session-tokens.mts` + token accounting before/after), not adding another mechanism. Most "this saves tokens" claims are unmeasured. **Wire estimate** (`estimateWireTokens` in `compaction.ts`) + pre-send guard with pending user + footer `wireTokens` ship as of K2.
2. **Generalize read-only mechanisms.** Several mechanisms cover only `read`: e.g. superseded-collapse (`buildSupersededReadIndices`) skips `bash`/`grep`/`ls`/`find`. Extending an existing, proven mechanism (cache-safe, same boundary) beats inventing a new one.
3. **Resolve unsettled trade-offs.** `frequent_files` in the suffix (grounding vs token re-bill), compaction aggressiveness (quality vs tokens) — these need a *measured A/B*, not a guess. Comportamento deve ficar idêntico ou melhor.
4. **Real capability gaps vs CC/Codex**, not late parity: what the Pit genuinely can't do that matters.
5. **Weak-model uplift**: the universal rail exists; specific axes are still open.
6. **Behavior under failure / UX**, not new features: where the loop *feels* stuck, ambiguous, or wasteful.

**Litmus test for a suggestion:** if it's "add «basic mechanism» X" → check above, it's likely there. The valuable suggestions today are **measure**, **generalize**, or **resolve a trade-off** — not add the basics.
