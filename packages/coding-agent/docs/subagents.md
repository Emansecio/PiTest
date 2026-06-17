# Subagents (the `task` tool)

The built-in `task` tool spawns a focused subagent to handle an isolated
sub-task and returns its final answer as a string. The subagent reuses the
parent's model, auth, and tool catalog (filtered) but runs in an in-memory
session, so its turns never persist to the parent's session file.

## When to use it

- **Decomposing**: break a large task into independent probes that can run in
  separate contexts.
- **Fanning out**: `spawn` N subagents non-blocking, keep working, then `join`
  to gather them all in parallel.
- **Restricting**: run a query with a narrow toolset (e.g. only `read` and
  `grep`) so the subagent can't mutate anything and its system prompt stays small.
- **Repeating**: ask the same question against multiple inputs without
  polluting the main conversation.

## Tool signature

`task` is a multi-op tool. The op is selected by the `op` field (default `run`):

| `op` | Behavior |
|------|----------|
| `run` (default) | Blocking — spawn the subagent and return its final answer. |
| `spawn` | Non-blocking — launch detached and return a `handle`. The result re-injects into the chat automatically when it finishes (see [async delegation](#async-delegation)). |
| `poll` | Non-blocking status of the given `handles`. |
| `join` | Await the given `handles` and collect their outputs. |
| `list` | List tracked subagents, live async handles, and resumable (interrupted) ones. |
| `resume` | Continue a subagent cut short by ESC or a network drop, by its `name`/handle, transcript intact. |
| `agents` | List the reusable agent types loaded from `.pit/agents/`. |

```jsonc
task({
  op:            "run",                       // optional; default "run"
  prompt:        "Find all unused imports in src/ and list them by file.",
  name:          "find-dead-code",            // optional handle (for spawn/poll/join/resume + worktree path)
  type:          "explorer",                  // optional reusable agent type from .pit/agents/<name>.md
  model:         "haiku",                     // optional; scale to sub-task complexity. Omit to inherit parent.
  thinking_level:"medium",                    // optional; minimal|low|medium|high|xhigh
  allowed_tools: ["read", "grep", "find"],    // optional; omit to inherit the parent's FULL catalog (costly)
  max_turns:     25,                          // optional, default 25
  system_prompt: "Optional override for the subagent's system prompt",
  result_schema: { type: "object", properties: { findings: { type: "array" } } }, // optional structured output
  worktree:      true,                        // optional; run in an isolated, auto-cleaned git worktree
  inherit_skills:false,                       // optional; append the parent's skills to the subagent prompt
  timeout_ms:    120000                       // optional wall-clock timeout
})
```

`run`/`resume` return the subagent's final assistant message as text. Tool
calls and intermediate output are not surfaced to the parent — only the final
answer. When `result_schema` is set, the final message is parsed and validated
against it and the structured value is returned.

## Inspection

Every spawned subagent is recorded on an in-memory registry, including
status (`pending`, `running`, `completed`, `failed`, `cancelled`), turn
count, and any error. Records are kept in memory only and are discarded on
session shutdown.

## Constraints

- Subagents **always think**: thinking defaults to `medium` and `off` is coerced
  to `medium`. Pass `thinking_level` to override per task.
- Recursion is bounded by nesting depth, not by tool catalog. The default
  `PIT_SUBAGENT_MAX_DEPTH` is `1`: a subagent never inherits the parent's `task`
  tool verbatim (that would let it recurse forever through the shared registry),
  and only receives a fresh, depth-incremented `task` tool while still within the
  budget. At the cap the tool is withheld entirely. Set `PIT_SUBAGENT_MAX_DEPTH=0`
  to disable subagents. (Coordinator tools are stripped by an internal brand, not
  by name, so a user tool also named `task` can't break the guard.)
- The output a subagent injects into the parent is capped (`PIT_SUBAGENT_MAX_BYTES`,
  default 24 KB; tail kept). The full output stays on the in-memory registry.
- Cancellation: when the parent agent's turn is aborted, the in-flight
  subagent receives the same `AbortSignal` and the registry status flips to
  `cancelled`. An aborted/dropped run that left a usable transcript becomes
  **resumable** (see below).

## Agent types (`.pit/agents/`)

Reusable presets, mirroring Claude Code's `.claude/agents/*.md`. A Markdown file
with optional frontmatter (`name`, `description`, `tools`, `model`, `thinking`)
plus a body (the system prompt) defines a type spawnable by name via
`task({ type: "<name>" })`. Any field set explicitly on the call overrides the
type's default. Discovery: `<cwd>/.pit/agents/*.md` (project) shadows
`~/.pit/agents/*.md` (user) on name collision. `task({ op: "agents" })` lists the
loaded types.

## Async delegation

`task({ op: "spawn" })` launches a subagent detached and returns a handle so the
parent can keep working. When the subagent settles, its result is **re-injected
into the chat automatically** — the model never has to poll. You may still
`poll` for status or `join` early to collect it. Disable the auto re-injection
with `PIT_NO_ASYNC_REINJECT` (falls back to manual `poll`/`join`).

## Inter-agent messaging

When messaging is enabled (default), parallel subagents get a `message` tool and
a coordination preamble. `message({ op: "list" })` shows who is online;
`message({ op: "send", to, message })` (a target id or `"all"`) asks a question
and returns the reply synchronously — so a subagent blocked on something another
agent owns can ask instead of guessing.

## Resume

A subagent interrupted by ESC or ended by a network drop (its last turn stopped
with `error`/`aborted`) is kept **resumable**, addressed by its `name`/handle.
`task({ op: "resume", name: "<handle>" })` re-drives it with its transcript
intact (pass `prompt` to steer the continuation). Two tiers back this:
Tier 1 keeps the live `Agent` in memory for the session; Tier 2 persists the
partial transcript to `<cwd>/.pit/subagents/<handle>.json`, so a resume survives
a Pit restart. (A subagent whose auto-cleanup worktree was removed on settle
can't be resumed — use `worktree: { cleanup: "keep" }` if you need that.)

## Programmatic access

Use `spawnSubagent` from `core/coordinator/index.ts` to run a subagent
without the built-in tool wrapper. The function takes a `SubagentRegistry`,
a parent model + tool list, and returns `{ record, output, value?, worktreePath? }`
(`value` is the parsed structured result when a `resultSchema` was passed;
`worktreePath` is set when a worktree was created).
