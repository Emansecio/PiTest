# Subagents (the `task` tool)

The built-in `task` tool spawns a focused subagent to handle an isolated
sub-task and returns its final answer as a string. The subagent reuses the
parent's model, auth, and tool catalog (filtered) but runs in an in-memory
session, so its turns never persist to the parent's session file.

Sibling tools **`parallel`** and **`fanout`** (same coordinator extension) cover
explicit fan-out and the scout → N reviewers → worker pattern.

## When to use it

- **Decomposing**: break a large task into independent probes that can run in
  separate contexts.
- **Fanning out**: `spawn` N subagents non-blocking, keep working, then `join`
  to gather them all in parallel — or call `parallel` / `fanout` for structured
  multi-agent flows.
- **Restricting**: run a query with a narrow toolset (e.g. only `read` and
  `grep`) so the subagent can't mutate anything and its system prompt stays small.
- **Repeating**: ask the same question against multiple inputs without
  polluting the main conversation.
- **Gating**: pass `acceptance` so a judge and/or shell check must pass before
  the result is treated as verified (on exhaustion the last output is still
  returned, flagged).

## Tool signature

`task` is a multi-op tool. The op is selected by the `op` field (default `run`):

| `op` | Behavior |
| ------ | ---------- |
| `run` (default) | Blocking — spawn the subagent and return its final answer. |
| `spawn` | Non-blocking — launch detached and return a `handle`. Collect the result later with `join` (or check `poll`); see [async delegation](#async-delegation). |
| `poll` | Non-blocking status of the given `handles`. |
| `join` | Await the given `handles` and collect their outputs. |
| `list` | List tracked subagents, live async handles, resumable (interrupted), and continuable (finished) ones. |
| `resume` | Continue a subagent cut short by ESC or a network drop, by its `name`/handle, transcript intact. |
| `continue` | Follow-up prompt on a **successfully finished** subagent (same live Agent / transcript). |
| `read` | Recover the **integral** output for a handle when the inline digest was truncated. |
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
  max_turns:     50,                          // optional, default 50
  system_prompt: "Optional override for the subagent's system prompt",
  result_schema: { type: "object", properties: { findings: { type: "array" } } }, // optional structured output
  acceptance:    { criteria: "List every unused import with file path", check: "npm test", max_attempts: 2 },
  worktree:      true,                        // optional; run in an isolated, auto-cleaned git worktree
  inherit_skills:false,                       // optional; append the parent's skills to the subagent prompt
  timeout_ms:    120000                       // optional wall-clock timeout
})
```

`run`/`resume`/`continue` return the subagent's final assistant message as text. Tool
calls and intermediate output are not surfaced to the parent — only the final
answer (as a **digest** when large; see caps below). When `result_schema` is set, the final message is parsed and validated
against it and the structured value is returned.

## Caps (defaults — override via env)

| Axis | Default | Env |
| ------ | --------- | ----- |
| Nesting depth | `1` (subagents cannot spawn subagents) | `PIT_SUBAGENT_MAX_DEPTH` |
| Concurrency | `4` live Agents (every worker, reviewer, scout, judge, resume) | `PIT_SUBAGENT_MAX_CONCURRENCY` |
| Queued runs | `8 × concurrency` | `PIT_SUBAGENT_MAX_QUEUE` |
| Inline digest | `4 KB` head+tail; full text via `op:"read"` | `PIT_SUBAGENT_MAX_BYTES` |
| Continuable / resumable memory | FIFO `8` live Agents | (fixed) |
| Persisted resume TTL | `7 days` | (fixed) |
| Max turns | `50` | per-call `max_turns` |

## Inspection

Every spawned subagent is recorded on an in-memory registry, including
status (`pending`, `running`, `completed`, `failed`, `cancelled`), turn
count, inclusive usage (`input + output + cacheRead + cacheWrite`), and any
error. Resume/continue follow-ups merge only their newly appended turns into
the original collision-resolved record. Completed scout/reviewer work is also
retained when a later fanout worker or acceptance judge fails, so Goal spend
and `op:"list"` do not lose already-incurred tokens. Records are kept in memory
only and are discarded on session shutdown. `op:"list"` also shows continuable
handles (for `op:"continue"`).

## Constraints

- Subagents **always think**: thinking defaults to model-bucketed `low`/`medium` and `off` is coerced
  to a thinking level. Pass `thinking_level` to override per task.
- Recursion is bounded by nesting depth. The default
  `PIT_SUBAGENT_MAX_DEPTH` is `1`: a subagent never inherits the parent's coordinator tools
  (`task` / `parallel` / `fanout`) verbatim, and only receives depth-incremented copies while within the
  budget. At the cap those tools are withheld entirely. Set `PIT_SUBAGENT_MAX_DEPTH=0`
  to disable subagents. (Coordinator tools are stripped by an internal brand, not
  by name.)
- Every live Agent consumes one process-wide concurrency slot — including
  `parallel`/`fanout` children, acceptance judges, and resume/continue runs.
  Nested blocking delegation temporarily yields the parent's slot while its
  child runs, so `PIT_SUBAGENT_MAX_DEPTH >= 2` cannot deadlock the slot pool.
- The output a subagent injects into the parent is a digest (`PIT_SUBAGENT_MAX_BYTES`,
  default 4 KB head+tail) plus a pointer; recover the full text with `task({op:"read", name})`.
  `parallel` and `fanout` apply the same rule per child/stage instead of dumping
  every integral output into the parent's context.
- `worktree: true` rebuilds cwd-sensitive native tools (`read`/write/edit/bash/
  search/AST/LSP/debug/eval tools) against the isolated checkout, preserving the
  parent session's configured shell/search/runtime options. Rebinding is
  fail-closed, guards are rooted in the worktree, and the child system prompt
  names its isolated cwd. Parent-bound `code` and coordinator tools are withheld
  because their session closures could escape the checkout. Extension/MCP tools
  are host-owned; pass explicit paths under the worktree when using them.
- Cancellation: when the parent is interrupted (Esc), in-flight **blocking** and **detached**
  subagents are aborted. A normal turn end does **not** abort detached `spawn` tasks.
  An aborted/dropped run that left a usable transcript becomes
  **resumable** (see below). Worktree `cleanup:"auto"` runs are not resumable/continuable.

## Agent types (`.pit/agents/`)

Reusable presets, mirroring Claude Code's `.claude/agents/*.md`. A Markdown file
with optional frontmatter (`name`, `description`, `tools`, `model`, `thinking`,
`memory`) plus a body (the system prompt) defines a type spawnable by name via
`task({ type: "<name>" })`, per `parallel` task, or per `fanout` stage. Any field
set explicitly on the call overrides the type's default. A type with
`memory: true` receives agent-type-scoped `recall`/`retain`/`reflect`; this
scoping is preserved in structured parallel/fanout runs. Discovery: `<cwd>/.pit/agents/*.md` (project) shadows
`~/.pit/agents/*.md` (user) on name collision. Built-ins (`explore`, `plan`,
`review`, `general`) load first. `task({ op: "agents" })` lists the
loaded types.

## Async delegation

`task({ op: "spawn" })` launches a subagent detached and returns a handle so the
parent can keep working. By default the result is **not** pushed into the chat —
when a subagent finishes it only emits a status line, and you collect its output
explicitly with `join` (await + read) or check `poll` for status. This mirrors
Claude Code: spawn N tasks, then `join` them and summarize, with no mid-turn
interruptions. Set `PIT_ASYNC_REINJECT=1` to opt into the legacy behavior where
each settled result is auto-injected into the chat.

Detached spawns also join the inter-agent message bus (when messaging is enabled)
and share the same concurrency / queue caps as blocking runs.

## Inter-agent messaging

When messaging is enabled (default), subagents launched through `task` run/spawn
get a `message` tool and a coordination preamble. `message({ op: "list" })` shows who is online;
`message({ op: "send", to, message })` (a target id or `"all"`) asks a question
and returns the reply synchronously — so a subagent blocked on something another
agent owns can ask instead of guessing.

## Resume / continue

A subagent interrupted by ESC or ended by a network drop (its last turn stopped
with `error`/`aborted`) is kept **resumable**, addressed by its `name`/handle.
`task({ op: "resume", name: "<handle>" })` re-drives it with its transcript
intact (pass `prompt` to steer the continuation). Two tiers back this:
Tier 1 keeps the live `Agent` in memory for the session; Tier 2 persists the
partial transcript to `<cwd>/.pit/subagents/<handle>.json`, so a resume survives
a Pit restart. Persisted transcripts pass through the same disk-egress secret
redactor as session artifacts and expire after seven days; stale files are
removed lazily on list/load. A kept worktree's isolated cwd is persisted too,
so a Tier-2 resume after restart rebinds tools to that same checkout rather than
the parent tree. (A subagent whose auto-cleanup worktree was removed on settle
can't be resumed — use `worktree: { cleanup: "keep" }` if you need that.)

A **successfully finished** subagent (no auto-cleanup worktree) stays
**continuable** (FIFO cap 8): `task({ op: "continue", name, prompt })` sends a
follow-up on the same live Agent.

Transport failures (5xx / overloaded / network) **before useful progress** get
one automatic retry inside `spawnSubagent`; after that, use `resume`.

## Acceptance / parallel / fanout

- **`acceptance`** on `task` (and parallel/fanout worker entries): optional
  `criteria` (judge subagent) and/or `check` (shell, exit 0). Retries up to
  `max_attempts` (default 2); on exhaustion returns the last output flagged
  (`isError: false`, `details.gate.passed: false`). Spend includes every worker
  attempt and semantic judge. For auto-cleanup worktrees, the checkout remains
  alive through judge/check evaluation and is removed immediately afterwards.
- **`parallel({ tasks, concurrency? })`**: run an explicit list concurrently
  (`allSettled` semantics). Each task accepts `type`, `model`,
  `thinking_level`, `allowed_tools`, `result_schema`, and `acceptance`. Child
  start/progress/complete events surface in the TUI, spend is recorded, and
  integral outputs remain recoverable through `task({op:"read", name})`.
- **`fanout({ scout, reviewer, worker, concurrency? })`**: scout lists
  `targets`, reviewers run per target (`{{target}}` in the template), then
  worker consumes the reviews (optional acceptance on the worker). Every stage
  accepts its own `type`, `model`, and `thinking_level`, enabling cheap reviewers
  with a stronger synthesis worker. Stage lifecycle and spend are surfaced like
  ordinary subagents; scout, reviewer, and worker outputs are digested with
  `op:"read"` recovery pointers.

## Programmatic access

Use `spawnSubagent` from `core/coordinator/index.ts` to run a subagent
without the built-in tool wrapper. The function takes a `SubagentRegistry`,
a parent model + tool list, and returns `{ record, output, value?, worktreePath? }`
(`value` is the parsed structured result when a `resultSchema` was passed;
`worktreePath` is set when a worktree was created). Higher-level helpers:
`runWithAcceptance`, `spawnAll`, `runFanout`.
