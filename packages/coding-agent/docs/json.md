# JSON Event Stream Mode

```bash
pit --mode json "Your prompt"
```

Outputs session events as JSON lines to stdout. Useful for integrating pit into other tools or custom UIs.

This is **print mode** (single-shot): the process sends the prompt, streams events, then exits. For a persistent bidirectional protocol, use [RPC mode](rpc.md).

## Streaming filter

Print JSON mode **drops `message_update` events**. Only completed messages and lifecycle events are serialized. This avoids O(tokens²) overhead from serializing every streaming delta. Clients that need live token streaming should use RPC mode (`pit --mode rpc`), which forwards all `message_update` events.

Implementation: [`src/modes/print-mode.ts`](../src/modes/print-mode.ts) (`session.subscribe` handler returns early for `message_update` when `mode === "json"`).

## Event Types

Events match `AgentSessionEvent` in [`src/core/agent-session-events.ts`](../src/core/agent-session-events.ts). Base events come from `AgentEvent` in `@pit/agent-core`; session extensions add the rest.

| Event | Emitted in print JSON? | Description |
|-------|------------------------|-------------|
| **Agent lifecycle** | | |
| `agent_start` | yes | Agent begins processing |
| `agent_end` | yes | Agent completes; includes `messages` and `willRetry` |
| `turn_start` | yes | New turn begins |
| `turn_end` | yes | Turn completes |
| **Message lifecycle** | | |
| `message_start` | yes | Message begins |
| `message_update` | **no** | Dropped in print JSON (see above) |
| `message_end` | yes | Message completes |
| **Tool execution** | | |
| `tool_execution_start` | yes | Tool begins |
| `tool_execution_update` | yes | Streaming tool output |
| `tool_execution_end` | yes | Tool completes |
| **Tool registry** | | |
| `tool_call_rewritten` | yes | Registry rewrote tool args |
| `tool_call_rejected` | yes | Registry blocked a tool call |
| `tool_error_hint_applied` | yes | Recovery hints on failed tool |
| **Queue & compaction** | | |
| `queue_update` | yes | Steering/follow-up queue changed |
| `compaction_start` / `compaction_end` | yes | Compaction lifecycle |
| **Retry & fallback** | | |
| `auto_retry_start` / `auto_retry_end` | yes | Transient error retry |
| `fallback_warning` | yes | Model switched to fallback |
| **Session state** | | |
| `session_info_changed` | yes | Session name changed |
| `thinking_level_changed` | yes | Thinking level changed |
| `orchestration_changed` | yes | `solo` ↔ `fusion` changed |
| **Fusion** | yes (when active) | |
| `fusion_stage` | yes | Pipeline stage |
| `fusion_member` | yes | Panel member status |
| `fusion_member_activity` | yes | Live panel activity |
| `fusion_verify_activity` | yes | Verify subagent progress |
| **Subagent** | yes | |
| `subagent_start` | yes | Background subagent started |
| `subagent_progress` | yes | Subagent turn progress |
| `subagent_complete` | yes | Subagent finished |
| **Goal pipeline** | yes (when active) | |
| `verification` | yes | Check command lifecycle |
| `pending_check` | yes | Background job drain |
| `visual_review` | yes | Visual DoD nudge |

For field-level examples of fusion, subagent, and goal-pipeline events, see [RPC mode — Events](rpc.md#events).

## Message Types

Base messages from `packages/ai/src/types.ts`:
- `UserMessage` (line 134)
- `AssistantMessage` (line 140)
- `ToolResultMessage` (line 152)

Extended messages from `packages/coding-agent/src/core/messages.ts`:
- `BashExecutionMessage` (line 29)
- `CustomMessage` (line 46)
- `BranchSummaryMessage` (line 55)
- `CompactionSummaryMessage` (line 62)

## Output Format

Each line is a JSON object. The first line is the session header:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur (note: no `message_update` lines):

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...],"willRetry":false}
```

When runtime diagnostics were collected, a final `{type:"diagnostics",...}` line is appended (from `@pit/ai` `getRuntimeDiagnostics()`).

In `text` print mode (not JSON), `fallback_warning` and failed `auto_retry_end` events are surfaced on stderr instead of stdout. JSON mode includes them in the event stream.

## Example

```bash
pit --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
