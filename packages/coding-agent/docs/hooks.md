# Hooks

Hooks are external commands Pi runs in response to specific lifecycle events.
They're configured in `settings.json` and run as separate processes, so any
language with stdio access works — shell, Python, Go, anything.

## Events

| Event | Fires | Can block | Use cases |
|-------|-------|-----------|-----------|
| `PreToolUse` | Before a tool executes | yes (denies the tool call) | extra gating, arg rewriting, audit log |
| `PostToolUse` | After a tool returns | no (can transform output) | redact secrets, summarize long output |
| `UserPromptSubmit` | After the user submits a prompt, before the agent loop | yes (cancels the turn) | inject context, enforce prompt policy |
| `Stop` | When the agent finishes a turn | no | auto-lint, auto-commit, post-run notification |

## Configuration

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "bash",
        "command": "bash scripts/audit-bash.sh",
        "timeoutMs": 5000,
        "name": "audit-bash"
      }
    ],
    "PostToolUse": [
      { "matcher": "edit|write", "command": "node scripts/redact.js" }
    ],
    "UserPromptSubmit": [
      { "command": "python scripts/inject-context.py" }
    ],
    "Stop": [
      { "command": "npm run lint --silent", "timeoutMs": 30000 }
    ]
  }
}
```

### Hook entry fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `command` | string | required | Shell command line (when `shell: true`) or executable + args (when `shell: false`) |
| `matcher` | string | match all | Regex applied to the tool name. Anchored; case-insensitive. Only used for tool-bound events. |
| `shell` | boolean | `true` | Run via the system shell (`bash -c` / `cmd /c`). When `false`, the command is split on whitespace and exec'd directly. |
| `timeoutMs` | number | `30000` | Hard timeout. The process is killed (SIGTERM → SIGKILL after 2s) on timeout. |
| `cwd` | string | session cwd | Override the working directory for this hook. |
| `name` | string | derived | Display label used in error logs. |

## I/O contract

Each hook receives a JSON payload on **stdin**:

```jsonc
// PreToolUse / PostToolUse
{ "event": "PreToolUse", "toolName": "bash", "toolCallId": "tc_…", "input": {…}, "cwd": "/…" }
{ "event": "PostToolUse", "toolName": "bash", "toolCallId": "tc_…", "input": {…}, "output": "…", "isError": false, "cwd": "/…" }

// UserPromptSubmit
{ "event": "UserPromptSubmit", "prompt": "…", "cwd": "/…" }

// Stop
{ "event": "Stop", "turnIndex": 4, "cwd": "/…" }
```

The hook responds with **JSON on stdout**:

```jsonc
{
  "decision": "allow" | "block",   // optional; default "allow"
  "reason":   "…",                 // surfaced to user / LLM on block
  "inputOverride":     { "command": "ls -la" },  // PreToolUse: replaces tool args
  "outputOverride":    "…",                       // PostToolUse: replaces output text
  "additionalContext": "…"                        // UserPromptSubmit: appended to prompt
}
```

Non-JSON output and empty stdout are treated as `{ decision: "allow" }`.

### Failure modes

| Condition | Effect |
|-----------|--------|
| Hook exits non-zero with no parsed JSON (PreToolUse) | **Tool is blocked**, stderr is surfaced as the block reason (fail-closed). |
| Hook exits non-zero with no parsed JSON (other events) | Error is logged; the event proceeds. |
| Hook times out | Same as a non-zero exit. |
| Multiple hooks for one event | Run sequentially; first `decision: "block"` short-circuits. For PreToolUse, every successful `inputOverride` is merged into `event.input` before the tool runs. |

## Example: deny `rm` outside the project

```bash
#!/usr/bin/env bash
# scripts/audit-bash.sh
payload=$(cat)
cmd=$(jq -r '.input.command' <<<"$payload")
if [[ "$cmd" =~ rm[[:space:]] ]] && [[ ! "$cmd" =~ ^cd[[:space:]] ]]; then
  jq -n --arg reason "rm requires explicit project-local cd first" \
    '{decision:"block",reason:$reason}'
  exit 0
fi
echo '{"decision":"allow"}'
```

## Programmatic access

Hooks are wired through the built-in `core/built-ins/hooks-extension.ts`. SDK
consumers can substitute their own runner by passing an
`extensionFactories` entry that subscribes to `tool_call`, `tool_result`,
`input`, and `agent_end` directly.
