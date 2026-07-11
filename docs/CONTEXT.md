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
A built-in extension that blocks `edit` and `write` tool calls on files not previously read in the current session. Prevents the model from generating diffs against hallucinated file content. Across a compaction boundary the read set is replaced by a `(mtimeMs, size)` stat snapshot: a post-compaction edit/write is allowed when the on-disk stat still matches (no forced re-read of unchanged files) and blocked with a "re-read it" reason when it drifted. A `write` that would overwrite a file only summarized across compaction additionally gets a fire-once warning (re-issue to proceed).

### Grounding Firewall
A family of pre-execution guards that ground a tool call's REFERENCES against reality before the call runs — siblings of the Read Guard. Four layers, each fail-open and opt-out via a `PIT_NO_*` env var: **symbol grounding** (a navigation `symbol` / breakpoint name checked against the living repo-map index + LSP workspace symbols — auto-fixed to the closest match or blocked with candidates); **import grounding** (a relative import specifier in a `write`/`edit` resolved against the filesystem, blocked with close filenames when it does not exist); **path grounding** (a `read`/`edit` target path resolved against the filesystem, blocked with candidates when missing); **pattern grounding** (a `grep`/`find` regex/glob structurally balance-checked so a malformed pattern is caught before it silently matches nothing — a malformed glob reads as a false "not found"). All four are block-only advice with a fire-once escape: re-issuing the identical call runs it.

### Permission Mode
The session-wide capability for tool execution, on a single axis. The code exposes two modes (`PermissionMode = "auto" | "plan"`): **plan** (read-only — filesystem/shell/code-execution tools blocked: `bash`/`edit`/`write`/`eval`/`debug`, `lsp` write actions, and `chrome_devtools` interaction ops); **auto** (default — writes enabled, but built-in deny rules are hard-blocked: sensitive paths like `.env`/`~/.ssh`, dangerous commands like `rm -rf /`/fork bomb — never prompted). `auto` is a *guarded* default. Dropping the builtin deny floor is `disableBuiltinDefaults`, not a third mode. User-authored `denyPaths`/`denyTools`/`denyCommands` are intentional and apply in every mode. There is no separate sandbox axis — containment is deny rules, not a cwd jail. Switched via the `--permission-mode` flag or `/permission-mode` command.
_Avoid_: yolo (removed); default (removed mode); approval-policy/sandbox-policy (codex's two axes — deliberately collapsed to one).

### Diff Limit (planned — not implemented)
A *proposed* built-in extension (see [ADR-0002](adr/0002-diff-limit-pause.md), status **Proposed**) that would pause execution and request user confirmation when a single turn produces more than a configured number of changed lines (default: 300), to curb over-engineering and unintended large-scale changes. **Not shipped:** there is no diff-limit code in `packages/coding-agent/src` (grep for `diffLimit|changedLines|DiffLimit` returns 0 matches) and no diff guard in the built-in factory array. Over-engineering is currently addressed only by the Karpathy **Engineering Style** prompt guidelines, not by runtime enforcement.

### Doom Loop
A pattern where the model retries the same failing tool call repeatedly without changing approach. Detected by `ToolCallStats` via consecutive identical (toolName, argsFingerprint) entries in the ring buffer; a complementary repeating-pattern detector catches a multi-tool CYCLE repeated at the tail (e.g. `[read,edit,bash]` run four times) that the consecutive-identical check misses. The harness escalates: reminder (3x) → pause (5x) → abort (8x).

### Engineering Style
Behavioral guidelines injected into the system prompt that bias the model toward surgical, minimal changes. Based on Karpathy guidelines plus a Ponytail-style solution ladder inside simplicity-first behavior: think before coding, identify root cause, prefer the smallest existing solution, surgical changes, goal-driven execution.

### Frequent Files Tracker
An in-session data structure that counts per-file read/write/edit operations. Used to surface recently-touched files in the system prompt, keeping the model anchored to relevant context without requiring explicit re-statement.

### Tool Call Stats
Per-session telemetry that counts calls/errors per tool and maintains a ring buffer of recent invocations for doom-loop detection. Bounded by design to prevent memory leaks in pathological loops.

### Subagent Coordinator
A built-in extension (`coordinator-extension.ts`) that registers the `task` tool (plus `parallel` and `fanout`), letting the model launch focused subagents — each runs its own in-memory `Agent` loop sharing the parent's model, auth, and a filtered tool catalog, gated through the parent's permission policy. Ops: **run** (blocking, returns the answer), **spawn** (detached → returns a handle; by default the parent collects via **poll**/**join** — opt into auto re-inject with `PIT_ASYNC_REINJECT`), **list** (active + resumable + continuable + disk-persisted), **continue** (follow-up on a finished subagent), **read** (recover full output past the digest), **agents**, **resume**. Also: **parallel** (N concurrent subtasks) and **fanout** (scout → N reviewers → worker). Optional `acceptance` gates (criteria judge and/or shell check). Recursion is bounded (`PIT_SUBAGENT_MAX_DEPTH`, default 1) and inline output is digest-capped (`PIT_SUBAGENT_MAX_BYTES`, default 4 KB head+tail). Esc aborts detached spawns; normal turn end does not.

### Agent Type
A curated, versioned subagent preset loaded from `.pit/agents/<name>.md` (project) or `~/.pit/agents/` (user; project overrides on name collision) — YAML frontmatter (`name`/`description`/`tools`/`model`/`thinking`) plus the Markdown body as the system prompt. Spawned by name via `task({type:"<name>"})`, which applies the preset as **defaults** that explicit `task` fields override. `task({op:"agents"})` lists the loaded types with origin. The native counterpart to Claude Code's `.claude/agents/`.

### Subagent Resume
Continuation of a subagent cut short by ESC or a long network drop, via `task({op:"resume", name})`, reusing the partial transcript rather than restarting. **Tier 1** keeps the live `Agent` in memory (same session). **Tier 2** also persists the transcript + spawn context to `.pit/subagents/<handle>.json` — the disk write is awaited, so an interrupted `run` is durable the moment it returns — so a resume survives a process restart; the file is removed once the resume completes. A worktree subagent with `cleanup:"auto"` is not resumable (its on-disk state is gone). Short drops self-recover via provider retries; resume is for long drops / ESC.

### Inter-Agent Messaging
A message bus (`message` tool, default-on) that lets concurrently-running agents coordinate: `op:"list"` shows who is online; `op:"send"` with `to` (an agent id or `"all"`) asks a question and returns the reply synchronously. Each subagent receives a coordination preamble naming its own id and its spawning parent.

### Fusion Mode
A multi-model panel (`/fusion`; `/model` split into judge→writer) that shells out to read-only model CLIs (codex / claude) and fuses their answers through a brainstorm → plan → subagent-driven execution cycle. Cycled with `alt+p`.

## Flagged ambiguities

- **"plan"** is overloaded: a **Permission Mode** (read-only enforcement) *and* a **model role** (`--plan` / `--role plan` — which model answers a planning turn). Unrelated axes — keep distinct: "plan mode" = permissions, "plan role" = model selection.
- **"yolo"** was used as an alias for `auto`, but connoted *no safety net* while `auto` keeps a builtin deny floor. Resolved: yolo removed. The code's `PermissionMode` is `auto | plan` only; a no-rails run is `auto` + `disableBuiltinDefaults`, not a separate mode.
- **"auto"** ≠ codex's `danger-full-access`. Pit's `auto` is guarded (builtins enforced); the codex-equivalent full-access is `auto` + `disableBuiltinDefaults`.

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
6. **References are grounded before they persist.** A symbol, import path, file path, or search pattern in a tool call is checked against reality (repo-map / LSP / filesystem / structural balance) before the call runs — fail-open, advice-only, re-issue to override. The Grounding Firewall is the pre-execution counterpart to the Read Guard.
