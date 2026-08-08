# Subagents (the `task` tool)

The built-in `task` tool spawns a focused subagent to handle an isolated
sub-task and returns its final answer as a string. The subagent inherits the
parent's working model by default, filtered tool catalog, and complete provider
request policy (auth resolution, credential rotation, retry/timeouts, headers,
transport, and provider request/response hooks). It runs in an in-memory
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
| `cancel` | Explicitly stop detached subagents or an in-flight `resume` by `handles`. |
| `list` | List tracked subagents, live async handles, resumable (interrupted), and continuable (finished) ones. |
| `resume` | Continue an interrupted subagent by handle; concurrent calls share one in-flight lifecycle. |
| `continue` | Follow-up prompt on a **successfully finished** subagent (same live Agent / transcript). |
| `read` | Recover one bounded output page by handle; follow `details.nextCursor` while `details.hasMore` is true. |
| `agents` | List the reusable agent types loaded from `.pit/agents/`. |

```jsonc
task({
  op:            "run",                       // optional; default "run"
  prompt:        "Find all unused imports in src/ and list them by file.",
  name:          "find-dead-code",            // optional handle (for spawn/poll/join/resume + worktree path)
  type:          "explore",                   // optional reusable agent type from .pit/agents/<name>.md
  model:         "provider/model-id",          // optional; omit to inherit the working parent model
  thinking_level:"medium",                    // optional; minimal|low|medium|high|xhigh
  allowed_tools: ["read", "grep", "find"],    // optional; omit to inherit the parent's FULL catalog (costly)
  max_turns:     50,                          // optional, default 50
  system_prompt: "Optional override for the subagent's system prompt",
  result_schema: { type: "object", properties: { findings: { type: "array" } } }, // optional structured output
  acceptance:    { criteria: "List every unused import with file path", check: "npm test", max_attempts: 2 },
  policy:        { allowedPaths: ["src"], forbidTestChanges: true }, // optional mutation policy
  // Also: deniedPaths, forbidTimeoutIncrease, forbidAssertionRemoval
  worktree:      true,                        // optional; run in an isolated, auto-cleaned git worktree
  inherit_skills:false                        // optional; append the parent's skills to the subagent prompt
})
```

## Mutation policy

`policy` is an edit-tool/path policy, not a filesystem sandbox. It is enforced before a tool marked `mutationGuard` executes. Paths are normalized before `allowedPaths`/`deniedPaths` checks; test-file, assertion-removal, and timeout-increase violations return an actionable tool error without applying the mutation. Custom tools must set `mutationGuard: true` and expose `path`, `file`, or `filePath` for path rules. Bash commands do not participate in `allowedPaths`/`deniedPaths`; they remain governed by permission and command-guard layers. Enforcing shell filesystem boundaries requires a separate sandbox or safe-exec design, not naive command parsing.

Subagents have no wall-clock execution timeout. A detached run continues until it finishes, reaches `max_turns`, the session is aborted, or the parent explicitly calls `task({ op: "cancel", handles: ["name"] })`.

## Harness state contracts

- Todo reminders carry a monotonic revision and session owner; stale reminder snapshots are discarded.
- The per-target retry budget rearms when the todo revision changes. Configure its limit with `PIT_TOOL_RETRY_BUDGET` (default `3`) or disable it with `PIT_NO_TOOL_RETRY_BUDGET=1`.
- Plan steps accept `verify_command` for an executable check and `verify_description` for explanatory text. Only `verify_command` is executed. The legacy `verify` field remains an alias for `verify_command`.

`run`/`resume`/`continue` return the subagent's final assistant message as text. Tool
calls and intermediate output are not surfaced to the parent — only the final
answer (as a **digest** when large; see caps below). When `result_schema` is set, the final message is parsed and validated
against it and the structured value is returned. Cancelled or failed runs retain `partial: true` registry metadata (files touched, commands, last error, and worktree path) and return a recoverable partial output.

## Caps (defaults — override via env)

| Axis | Default | Env |
| ------ | --------- | ----- |
| Nesting depth | `1` (subagents cannot spawn subagents) | `PIT_SUBAGENT_MAX_DEPTH` |
| Concurrency | `4` live Agents (every worker, reviewer, scout, judge, resume) | `PIT_SUBAGENT_MAX_CONCURRENCY` |
| Queued runs | `8 × concurrency` | `PIT_SUBAGENT_MAX_QUEUE` |
| Inline digest | `4 KB` head+tail; bounded pages via `op:"read"` | `PIT_SUBAGENT_MAX_BYTES` |
| Recovery page | `32 KB` default; `48 KB` maximum | per-call `page_bytes` |
| Continuable / resumable memory | FIFO `8` live Agents | (fixed) |
| Persisted resume TTL | `7 days` | (fixed) |
| Max turns | `50` | per-call `max_turns` |

## Inspection

Every spawned subagent is recorded on an in-memory registry, including
status (`pending`, `running`, `completed`, `failed`, `cancelled`), turn
count, inclusive usage (`input + output + cacheRead + cacheWrite`), and any
error. Execution manifests are updated after each tool call. Resume/continue follow-ups merge only their newly appended turns into
the original collision-resolved record. Completed scout/reviewer work is also
retained when a later fanout worker or acceptance judge fails, so Goal spend
and `op:"list"` do not lose already-incurred tokens. Records are kept in memory
only and are discarded on session shutdown. `op:"list"` also shows continuable
handles (for `op:"continue"`).

## Constraints

- Model overrides resolve against one selectable view: registry models, SDK
  `scopedModels`, and the exact current parent model. Entries are deduplicated by
  canonical provider/id while preserving SDK-scoped and current model objects.
  Use an unambiguous registry/scoped id or canonical `provider/model`; custom
  model ids are accepted when that provider has a registry template, including
  a thinking suffix such as `provider/custom-id:high`. Unknown explicit models
  fail loudly instead of silently using the parent. The stock `explore` type
  does not pin a provider-specific small model; it inherits the working parent.
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
  default 4 KB head+tail) plus a pointer. Start recovery with `task({op:"read", name})`,
  then pass `details.nextCursor` as `cursor` until `details.hasMore` is false; optional
  `page_bytes` is capped at 48 KB. Pages use byte cursors and never split UTF-8 code points.
  `parallel` and `fanout` apply the same rule per child/stage instead of dumping
  retained outputs into the parent's context. Recovery is session-scoped and
  best-effort: the in-memory registry is primary; the redacted temp-disk store is
  capped at 256 entries/16 MiB, may evict or reject oversized output, and is removed
  on session disposal. Process restart does not preserve final-output recovery.
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

A subagent interrupted by ESC, ended by a network drop, or stopped at `max_turns`
is kept **resumable**, addressed by its `name`/handle. Turn-cap recovery also
applies to workers that use an acceptance gate.
`task({ op: "resume", name: "<handle>" })` re-drives it with its transcript
intact (pass `prompt` to steer the continuation). Concurrent resumes are idempotent and share one in-flight lifecycle; `poll`, `join`, and `cancel` resolve the active handle. Two tiers back this:
Tier 1 keeps the live `Agent` in memory for the session; Tier 2 persists the
partial transcript to `<cwd>/.pit/subagents/<handle>.json`, so a resume survives
a Pit restart. New resume files persist the canonical model provider and id, so
Tier-2 resume reconstructs the same provider (including custom model ids) rather
than selecting an ambiguous same-id model or switching to the parent provider.
Legacy id-only files remain resumable when the id is unambiguous. Persisted
transcripts pass through the same disk-egress secret redactor as session artifacts and expire after seven days; stale files are
removed lazily on list/load. A kept worktree's isolated cwd is persisted too,
so a Tier-2 resume after restart rebinds tools to that same checkout rather than
the parent tree. (A subagent whose auto-cleanup worktree was removed on settle
can't be resumed — use `worktree: { cleanup: "keep" }` if you need that.)

A **successfully finished** subagent (no auto-cleanup worktree) stays
**continuable** (FIFO cap 8): `task({ op: "continue", name, prompt })` sends a
follow-up on the same live Agent.

Transport failures (5xx / overloaded / network) **before useful progress** get
one automatic retry inside `spawnSubagent`; after that, use `resume`. If an
explicit child model is rejected for auth/OAuth policy before any tool call, Pit
retries once on the working parent model and surfaces a `[model fallback: ...]`
diagnostic in the result. Missing-key, expired/revoked OAuth, and provider
401/403 failures are classified as auth failures. Fallback is never attempted
after a tool call or useful assistant output. The effective working model is
persisted for Tier-2 resume, and `parallel`/`fanout` expose the same provenance
in both their text output and structured details.

## Acceptance / parallel / fanout

- **`acceptance`** on `task` (and parallel/fanout worker entries): optional
 `criteria` (judge subagent) and/or `check` (shell, exit 0). Acceptance gates
 require Auto permission mode; Plan and Ask delegation reject them fail-closed
 until judge tool catalogs are included in the authorization proof. Retries up to
 `max_attempts` (default 2); `check_timeout_ms` bounds each shell check
 (default 120000, maximum 600000). On exhaustion the last output is returned
 with `isError: true` and `details.gate.passed: false`, so it cannot be resumed
 as if it had passed. Spend includes every worker attempt and semantic judge.
 For auto-cleanup worktrees, the checkout remains alive through judge/check
 evaluation and is removed immediately afterwards.
- **`parallel({ tasks, concurrency? })`**: run an explicit list concurrently
  (`allSettled` semantics). Each task accepts `type`, `model`,
  `thinking_level`, `allowed_tools`, `result_schema`, and `acceptance`. Child
  start/progress/complete events surface in the TUI, spend is recorded, and
  retained outputs support bounded paged recovery through `task({op:"read", name})`.
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
`runWithAcceptance`, `spawnAll`, `runFanout`. Direct callers may provide a
`requestPolicy`; when omitted, `spawnSubagent` retains its registry-backed auth
and streaming fallback.
