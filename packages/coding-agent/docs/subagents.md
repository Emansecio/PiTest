# Subagents (the `task` tool)

The built-in `task` tool spawns a focused subagent to handle an isolated
sub-task and returns its final answer as a string. The subagent reuses the
parent's model, auth, and tool catalog (filtered) but runs in an in-memory
session, so its turns never persist to the parent's session file.

## When to use it

- **Decomposing**: break a large task into independent probes that can run in
  separate contexts.
- **Sandboxing**: run a query with a restricted toolset (e.g. only `read` and
  `grep`) so the subagent can't mutate anything.
- **Repeating**: ask the same question against multiple inputs without
  polluting the main conversation.

## Tool signature

```jsonc
task({
  prompt:        "Find all unused imports in src/ and list them by file.",
  system_prompt: "Optional override for the subagent's system prompt",
  allowed_tools: ["read", "grep", "find"],   // optional
  max_turns:     25                           // optional, default 25
})
```

Returns the final assistant message from the subagent as text. Tool calls and
intermediate output are not surfaced to the parent — only the final answer.

## Inspection

`/tasks` lists every subagent spawned in the current session, including
status (`pending`, `running`, `completed`, `failed`, `cancelled`), turn
count, and any error. Records are kept in memory only and are discarded on
session shutdown.

## Constraints

- The subagent uses thinking level `off`. Reasoning happens implicitly via
  tool calls; explicit thinking is reserved for the parent.
- The subagent cannot spawn further subagents recursively (the `task` tool is
  intentionally not included in the default `allowed_tools` for a subagent).
  Pass `allowed_tools: ["task", …]` if you want to allow this.
- Cancellation: when the parent agent's turn is aborted, the in-flight
  subagent receives the same `AbortSignal` and the registry status flips to
  `cancelled`.

## Programmatic access

Use `spawnSubagent` from `core/coordinator/index.ts` to run a subagent
without the built-in tool wrapper. The function takes a `SubagentRegistry`,
a parent model + tool list, and returns `{ record, output }`.
