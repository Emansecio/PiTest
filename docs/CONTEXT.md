# PiTest Domain Context

## Glossary

### Harness
The runtime infrastructure that wraps the LLM: system prompt construction, tool dispatch, permission gating, compaction, session management, and behavioral guardrails. The harness determines model quality more than the model itself.

### Agent Session
The main loop that orchestrates a conversation turn: user input → system prompt assembly → LLM call → tool call interception → tool execution → result flow → compaction check. Lives in `agent-session.ts`.

### Compaction
Context window management strategy. When accumulated tokens approach the context limit, older messages are summarized by the LLM and replaced with a structured summary. Preserves file operations, decisions, and recent context. Drops verbatim tool results and intermediate reads.

### Built-in Extension
A modular behavioral feature implemented as an extension factory (like `permissions-extension.ts`). Hooks into the agent session pipeline via events (`tool_call`, `afterToolCall`, `before_agent_start`, `message_end`). Can be enabled/disabled without modifying the core loop.

### Read Guard
A built-in extension that blocks `edit` and `write` tool calls on files not previously read in the current session. Prevents the model from generating diffs against hallucinated file content. Read tracking resets after compaction.

### Permission Mode
The session-wide capability tier for tool execution, on a single axis of increasing permissiveness. Three modes: **plan** (read-only — `bash`/`edit`/`write` blocked); **auto** (default — writes enabled, but built-in deny rules are hard-blocked: sensitive paths like `.env`/`~/.ssh`, dangerous commands like `rm -rf /`/fork bomb — never prompted); **unsafe** (writes enabled, builtin floor OFF — a no-rails run for authorized targets). `auto` is a *guarded* default; `unsafe` is the explicit opt-out, surfaced loudly (footer alert) so it is never on by accident. `unsafe` only drops the *builtin* defaults — user-authored `denyPaths`/`denyTools`/`denyCommands` are intentional and apply in every mode (so `unsafe` ≡ `auto` + `disableBuiltinDefaults`). There is no separate sandbox axis — containment is deny rules, not a cwd jail. Switched via `--permission-mode`/`--unsafe` flags or `/permission-mode`/`/unsafe` commands.
_Avoid_: yolo (removed — `unsafe` is the honest name for the no-rails tier), default (removed mode), approval-policy/sandbox-policy (codex's two axes — deliberately collapsed to one).

### Diff Limit
A built-in extension that pauses execution and requests user confirmation when a single turn produces more than a configured number of changed lines (default: 300). Prevents over-engineering and unintended large-scale changes.

### Doom Loop
A pattern where the model retries the same failing tool call repeatedly without changing approach. Detected by `ToolCallStats` via consecutive identical (toolName, argsFingerprint) entries in the ring buffer. The harness escalates: reminder (3x) → pause (5x) → abort (8x).

### Engineering Style
Behavioral guidelines injected into the system prompt that bias the model toward surgical, minimal changes. Based on Karpathy guidelines: think before coding, simplicity first, surgical changes, goal-driven execution.

### Frequent Files Tracker
An in-session data structure that counts per-file read/write/edit operations. Used to surface recently-touched files in the system prompt, keeping the model anchored to relevant context without requiring explicit re-statement.

### Tool Call Stats
Per-session telemetry that counts calls/errors per tool and maintains a ring buffer of recent invocations for doom-loop detection. Bounded by design to prevent memory leaks in pathological loops.

## Flagged ambiguities

- **"plan"** is overloaded: a **Permission Mode** (read-only enforcement) *and* a **model role** (`--plan` / `--role plan` — which model answers a planning turn). Unrelated axes — keep distinct: "plan mode" = permissions, "plan role" = model selection.
- **"yolo"** was used as an alias for `auto`, but connoted *no safety net* while `auto` keeps a builtin deny floor. Resolved: yolo removed; the no-rails tier is the explicit **unsafe** mode (honest name), not a misnamed alias.
- **"auto"** ≠ codex's `danger-full-access`. Pit's `auto` is guarded (builtins enforced); the codex-equivalent full-access is the **unsafe** mode.

## Interactive TUI Rendering

### Activity Group
A summary line that folds a contiguous burst of **navigation** tool calls into one aggregated counter (`✓ Explored 3 files · 1 search`). Read-only orientation noise; collapses by design. Children render only when expanded (`ctrl+o`). Style is Amp-inspired: state icon, no gutter, light-weight counter, clickable paths.

### Tool Family
Every tool declares an `activity` family: **navigation** (read/grep/ls/find/symbol — read-only orientation) or **action** (edit/write/bash/web/eval — observable effect). Navigation folds into an Activity Group; action breaks the group and gets its own line. Default for unknown/extension/MCP tools is **action** (safer: shows rather than hides). An action emitted mid-burst closes the open group.

### Action Line
A single tool call with observable effect, rendered on its own line with a category-specific verb + target (`✓ Edited foo.ts +12 -3`, `✓ Ran $ npm test`, `✓ Wrote bar.ts`, `✓ Fetched example.com`). Actions are signal, not noise — they are never folded into a counter. (Decision 2026-06-04: reverts commit 58366b8c which had folded actions into the group under a generic `Did` verb.)

### Narration vs Deliverable
The agent emits multiple visible `text` blocks across a turn: intermediate **narration** ("I'll update the manual…") interleaved with tool calls, and a final **deliverable** (the answer/summary). The deliverable is detected by heuristic: **the last text block of the turn** (no tool call or further text after it). The deliverable is marked with a single pulsing `●` glyph (brightens then settles to an accent color) before its first line; narration stays normal-weight (dimming deferred). Three-tier hierarchy: thinking (dim, italic) < narration (normal) < deliverable (normal + `●`).

## Architectural Invariants

1. **Agent session is the orchestrator, not the implementor.** Behavioral features live in built-in extensions, not inline in agent-session.ts.
2. **Compaction preserves decisions, not text.** Summaries capture what was decided and why, not verbatim tool outputs.
3. **The model must prove it knows file state before mutating it.** Read guard enforces this at runtime.
4. **Escalation over termination.** The harness warns before blocking, blocks before aborting.
5. **Token budget is implicit.** Context window management happens via compaction triggers, not explicit per-turn budgets.
