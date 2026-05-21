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

## Architectural Invariants

1. **Agent session is the orchestrator, not the implementor.** Behavioral features live in built-in extensions, not inline in agent-session.ts.
2. **Compaction preserves decisions, not text.** Summaries capture what was decided and why, not verbatim tool outputs.
3. **The model must prove it knows file state before mutating it.** Read guard enforces this at runtime.
4. **Escalation over termination.** The harness warns before blocking, blocks before aborting.
5. **Token budget is implicit.** Context window management happens via compaction triggers, not explicit per-turn budgets.
