# Settings

Pit uses JSON settings files with project settings overriding global settings.

| Location | Scope |
|----------|-------|
| `~/.pit/agent/settings.json` | Global (all projects) |
| `.pit/settings.json` | Project (current directory) |

Edit directly or use `/settings` for common options.

## All Settings

### Model & Thinking

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `defaultProvider` | string | - | Default provider (e.g., `"anthropic"`, `"openai"`) |
| `defaultModel` | string | - | Default model ID |
| `defaultThinkingLevel` | string | - | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output |
| `thinkingBudgets` | object | - | Custom token budgets per thinking level |

#### thinkingBudgets

```json
{
  "thinkingBudgets": {
    "minimal": 1024,
    "low": 4096,
    "medium": 10240,
    "high": 32768
  }
}
```

### UI & Display

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `theme` | string | `"dark"` | Theme name (`"dark"`, `"light"`, or custom) |
| `quietStartup` | boolean | `false` | Hide startup header |
| `doubleEscapeAction` | string | `"tree"` | Action for double-escape: `"tree"`, `"fork"`, or `"none"` |
| `treeFilterMode` | string | `"default"` | Default filter for `/tree`: `"default"`, `"no-tools"`, `"user-only"`, `"labeled-only"`, `"all"` |
| `editorPaddingX` | number | `0` | Horizontal padding for input editor (0-3) |
| `autocompleteMaxVisible` | number | `5` | Max visible items in autocomplete dropdown (3-20) |
| `assistantReadingColumns` | number | `0` | Reading-column cap (cols) for assistant prose. `0` (default) = full width, like Claude Code; a positive value (clamped 40-200) wraps long answers at that measure. Tool/bash/code blocks are never capped |
| `showHardwareCursor` | boolean | `false` | Show terminal cursor |
| `cursorBlink` | boolean | `true` | Blink the input editor's block cursor while focused |
| `streamingSmoothing` | boolean | `true` | Reveal streamed assistant text at a steady rate instead of provider-sized bursts |
| `toolActivity` | string | `"grouped"` | Tool rendering in the TUI: `"grouped"` groups consecutive tool calls into activity lines; `"legacy"` keeps one stacked block per call |

### Update checks

Pit fetches `https://pit.dev/api/latest-version` at startup to look for a newer version.

Set `PIT_SKIP_VERSION_CHECK=1` to disable the Pit version update check. Use `--offline` or `PIT_OFFLINE=1` to disable all startup network operations described here, including update checks and package update checks.

### Warnings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `warnings.anthropicExtraUsage` | boolean | `true` | Show a warning when Anthropic subscription auth may use paid extra usage |
| `warnings.newVersion` | boolean | `false` | Show "new version available" banner at startup (opt-in) |
| `warnings.packageUpdates` | boolean | `false` | Show "package updates available" banner at startup (opt-in) |

```json
{
  "warnings": {
    "anthropicExtraUsage": false
  }
}
```

### Compaction

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `compaction.enabled` | boolean | `true` | Enable auto-compaction |
| `compaction.reserveTokens` | number | `16384` | Tokens reserved for LLM response |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens to keep (not summarized) |
| `compaction.selfCorrection` | boolean | `true` | Extra verification LLM pass after summarization |

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

### Branch Summary

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved for branch summarization |
| `branchSummary.skipPrompt` | boolean | `false` | Skip "Summarize branch?" prompt on `/tree` navigation (defaults to no summary) |

### Retry

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry on transient errors |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts |
| `retry.baseDelayMs` | number | `2000` | Base delay for agent-level exponential backoff (2s, 4s, 8s) |
| `retry.provider.timeoutMs` | number | SDK default | Provider/SDK request timeout in milliseconds |
| `retry.provider.maxRetries` | number | SDK default | Provider/SDK retry attempts |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Max server-requested delay before failing (60s) |

When a provider requests a retry delay longer than `retry.provider.maxRetryDelayMs` (e.g., Google's "quota will reset after 5h"), the request fails immediately with an informative error instead of waiting silently. Set to `0` to disable the cap.

```json
{
  "retry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "provider": {
      "timeoutMs": 3600000,
      "maxRetries": 0,
      "maxRetryDelayMs": 60000
    }
  }
}
```

### Message Delivery

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `steeringMode` | string | `"one-at-a-time"` | How steering messages are sent: `"all"` or `"one-at-a-time"` |
| `followUpMode` | string | `"one-at-a-time"` | How follow-up messages are sent: `"all"` or `"one-at-a-time"` |
| `transport` | string | `"auto"` | Preferred transport for providers that support multiple transports: `"sse"`, `"websocket"`, or `"auto"` |

### Terminal & Images

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `terminal.showImages` | boolean | `true` | Show images in terminal (if supported) |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when content shrinks (can cause flicker) |
| `terminal.showTerminalProgress` | boolean | `false` | OSC 9;4 terminal progress indicators |
| `images.autoResize` | boolean | `true` | Resize images to 2000x2000 max |
| `images.blockImages` | boolean | `false` | Block all images from being sent to LLM |

### Shell

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `shellPath` | string | - | Custom shell path (e.g., for Cygwin on Windows) |
| `shellCommandPrefix` | string | - | Prefix for every bash command (e.g., `"shopt -s expand_aliases"`) |
| `npmCommand` | string[] | - | Command argv used for npm package lookup/install operations (e.g., `["mise", "exec", "node@20", "--", "npm"]`) |

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

`npmCommand` is used for all npm package-manager operations, including installs, uninstalls, and dependency installs inside git packages. User-scoped npm packages install under `~/.pit/agent/npm/`; project-scoped npm packages install under `.pit/npm/`. Use argv-style entries exactly as the process should be launched. When `npmCommand` is configured, git package dependency installs use plain `install` to avoid npm-specific flags in wrappers or alternate package managers.

### Sessions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sessionDir` | string | - | Directory where session files are stored. Accepts absolute or relative paths, plus `~`. |

```json
{ "sessionDir": ".pit/sessions" }
```

When multiple sources specify a session directory, precedence is `--session-dir`, `PIT_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json.

### Model Cycling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `enabledModels` | string[] | - | Model patterns for Ctrl+P cycling (same format as `--models` CLI flag) |

```json
{
  "enabledModels": ["claude-*", "gpt-4o", "gemini-2*"]
}
```

### Markdown

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `markdown.codeBlockIndent` | string | `"  "` | Indentation for code blocks |

### Resources

These settings define where to load extensions, skills, prompts, and themes from.

Paths in `~/.pit/agent/settings.json` resolve relative to `~/.pit/agent`. Paths in `.pit/settings.json` resolve relative to `.pit`. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `packages` | array | `[]` | npm/git packages to load resources from |
| `extensions` | string[] | `[]` | Local extension file paths or directories |
| `skills` | string[] | `[]` | Local skill file paths or directories |
| `prompts` | string[] | `[]` | Local prompt template paths or directories |
| `themes` | string[] | `[]` | Local theme file paths or directories |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands |

Arrays support glob patterns and exclusions. Use `!pattern` to exclude. Use `+path` to force-include an exact path and `-path` to force-exclude an exact path.

#### packages

String form loads all resources from a package:

```json
{
  "packages": ["pi-skills", "@org/my-extension"]
}
```

Object form filters which resources to load:

```json
{
  "packages": [
    {
      "source": "pi-skills",
      "skills": ["brave-search", "transcribe"],
      "extensions": []
    }
  ]
}
```

See [packages.md](packages.md) for package management details.

### Permissions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `permissions.mode` | string | `"auto"` | `"plan"` or `"auto"`. Override per-run with `--permission-mode`. |
| `permissions.allowPaths` | array | `[]` | Paths always allowed (each entry: `{ glob, tools?, reason? }`). |
| `permissions.denyPaths` | array | `[]` | Paths always blocked. Built-in defaults (`.env`, `~/.ssh/**`, …) are appended unless disabled. |
| `permissions.denyCommands` | array | `[]` | Bash command regex denylist (each entry: `{ pattern, flags?, reason? }`). Built-in dangerous-command defaults appended unless disabled. |
| `permissions.allowTools` | string[] | `[]` | Tool names that bypass checks. |
| `permissions.denyTools` | string[] | `[]` | Tool names that are always blocked. |
| `permissions.disableBuiltinDefaults` | boolean | `false` | Skip the built-in sensitive-paths and dangerous-commands lists — a no-rails state surfaced loudly in the footer. |

See [permissions.md](permissions.md) for the full rule format and precedence.

### Hooks

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `hooks.PreToolUse` | array | `[]` | Hooks fired before each tool call. May block or rewrite args. |
| `hooks.PostToolUse` | array | `[]` | Hooks fired after each tool call. May transform output. |
| `hooks.UserPromptSubmit` | array | `[]` | Hooks fired when the user submits a prompt. May block or add context. |
| `hooks.Stop` | array | `[]` | Hooks fired when the agent finishes a turn. |
| `hooks.SessionStart` | array | `[]` | Hooks fired when a session starts, loads, or reloads. Informative only — cannot block. |
| `hooks.PreCompact` | array | `[]` | Hooks fired before context compaction runs. Informative only — cannot block or cancel. |

Each entry: `{ command, matcher?, shell?, timeoutMs?, cwd?, name? }`. See [hooks.md](hooks.md) for the JSON stdin/stdout contract.

### MCP servers

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `mcp.servers.<name>.url` | string | required | JSON-RPC 2.0 HTTP endpoint. |
| `mcp.servers.<name>.headers` | object | – | Static request headers. |
| `mcp.servers.<name>.timeoutMs` | number | `30000` | Per-request timeout. |
| `mcp.servers.<name>.disabled` | boolean | `false` | Skip without removing. |
| `mcp.servers.<name>.allowTools` / `denyTools` | string[] | – | Per-server tool filter. |
| `mcp.servers.<name>.toolPrefix` | string | `"mcp__<name>__"` | Prefix used when registering tools with Pit. |
| `mcp.servers.<name>.defer` | boolean | – | Per-server override of the global `defer` policy: `true` always defers this server's tools, `false` keeps them eager. |
| `mcp.defer` | string | `"auto"` | When to keep MCP tool schemas off the active surface (deferred tools are pulled in on demand via `search_tool_bm25`): `"auto"` defers servers with `deferThreshold`+ tools, `"always"` defers every server, `"never"` registers everything eagerly. Requires tool discovery. |
| `mcp.deferThreshold` | number | `10` | Tool-count threshold for `defer: "auto"`. |

See [mcp.md](mcp.md) for protocol details and reconnect behavior.

### Memory

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `memory.disableInjection` | boolean | `false` | Don't inject `MEMORY.md` into the system prompt. The `memory_append` tool still works. |

See [memory.md](memory.md) for the file format and discovery order.

### Verification

After a code-modifying turn, Pit can run the project check command and self-correct on failure.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `verification.enabled` | boolean | `true` | Run the verification gate after code-modifying turns |
| `verification.command` | string | `null` | Check command; `null` auto-detects from `package.json` scripts (check/typecheck/lint/test) |
| `verification.maxAttempts` | number | `2` | Fix attempts before giving up and reporting the failure (min 1) |
| `verification.timeoutMs` | number | `180000` | Timeout for the check command (min 1000) |
| `verification.visual` | boolean | `true` | Nudge to `preview` when a rendered artifact changed but was never viewed |

### Eval

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `eval.enabled` | boolean | `true` | Register the `eval` tool. The session boots a persistent Python + JS kernel manager; each kernel is spawned lazily on first use |

### LSP

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `lsp.enabled` | boolean | `true` | Register the `lsp` tool; language servers cold-start on first use |
| `lsp.diagnosticsOnWrite` | boolean | `true` | Attach LSP diagnostics to write/edit results |
| `lsp.formatOnWrite` | boolean | `false` | Format files via the language server before writing them |

### Debug (DAP)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `debug.enabled` | boolean | `true` | Register the `debug` tool for driving a DAP debugger; adapters cold-start on first use |

### Chrome DevTools

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `chromeDevtools.enabled` | boolean | `true` | Register the `chrome_devtools_*` tools |
| `chromeDevtools.debugPort` | number | `9222` | Chrome remote-debugging port |
| `chromeDevtools.host` | string | `"127.0.0.1"` | Chrome remote-debugging host |
| `chromeDevtools.launchBrowser` | boolean | `true` | Auto-launch Chrome into a dedicated persistent profile when not reachable |
| `chromeDevtools.binaryPath` | string | - | Chrome binary path override |

The env vars `PIT_CHROME_DEVTOOLS_HOST`, `PIT_CHROME_DEVTOOLS_PORT`, and `PIT_CHROME_DEVTOOLS_BINARY` win over settings (the legacy `PI_*` names are still read as a fallback).

### Web Search

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `webSearch.enabled` | boolean | `true` | Register the `web_search` tool. Providers without env keys fall through the chain, so being enabled with no keys is a no-op |
| `webSearch.defaultProvider` | string | `"auto"` | Chain entry point; `"auto"` walks the configured provider chain |
| `webSearch.providers.<name>.apiKey` | string | - | Per-provider API key override |

### Hindsight Memory

Per-project memory bank backing the `retain`, `recall`, `reflect`, and `forget` tools.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `hindsight.enabled` | boolean | `true` | Register the hindsight tools and open the per-project bank at session start |
| `hindsight.bankPath` | string | - | Bank location; defaults to `<cwd>/.pit/hindsight/bank.jsonl` |
| `hindsight.maxEntries` | number | - | Hard ceiling on entry count; oldest entries evicted on open |
| `hindsight.pruneOlderThanDays` | number | - | Drop entries older than this many days on open |

### Frequent Files

Surfaces recently-touched files in the prompt to cut redundant searches/reads. The section is only emitted once entries clear `minHits`.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `frequentFiles.enabled` | boolean | `true` | Enable the frequent-files prompt section |
| `frequentFiles.topN` | number | `10` | Entries surfaced in the prompt |
| `frequentFiles.minHits` | number | `2` | Filter out one-touch noise |
| `frequentFiles.maxFiles` | number | `256` | In-memory tracker cap |

### Tool Discovery

The `search_tool_bm25` tool is always registered; these settings gate auto-seeding of the hidden tool index at session boot and which tools live where.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `toolDiscovery.enabled` | boolean | `true` | Seed the hidden tool index so `search_tool_bm25` can surface off-surface tools on demand |
| `toolDiscovery.alwaysActive` | string[] | `[]` | Tools to keep on the active surface even if they would be hidden |
| `toolDiscovery.hiddenByDefault` | string[] | `[]` | Tools to remove from the active surface and index as hidden |

### Agent Messaging

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `agentMessaging.enabled` | boolean | `true` | Register the `message` tool so sub-agents can send typed messages to their parent |
| `agentMessaging.timeoutMs` | number | `120000` | Per-message reply timeout in ms; `0` disables the timeout |

### Tool Feedback

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `toolFeedback.errorReflection.enabled` | boolean | `false` | Inject a reflection prompt as a follow-up turn after a tool error (opt-in; inline error results and hint rules already cover this) |
| `toolFeedback.doomLoopReminder.enabled` | boolean | `true` | Inject a reminder when consecutive identical tool calls reach the threshold |
| `toolFeedback.doomLoopReminder.threshold` | number | `2` | Consecutive identical tool calls that trigger a reminder |
| `toolFeedback.doomLoopReminder.cooldownMs` | number | `30000` | Minimum gap between reminders |
| `toolFeedback.stagnationReminder.enabled` | boolean | `true` | Remind/pause when the agent stops making progress |
| `toolFeedback.stagnationReminder.softThreshold` | number | `12` | Non-productive turns that trigger a reminder |
| `toolFeedback.stagnationReminder.hardThreshold` | number | `25` | Non-productive turns that pause for user guidance (clamped to at least `softThreshold`) |
| `toolFeedback.stagnationReminder.cooldownMs` | number | `30000` | Minimum gap between soft reminders |
| `toolFeedback.crossErrorReminder.enabled` | boolean | `true` | Inject a reminder when the same normalised error recurs across ≥2 distinct call shapes (flailing) |
| `toolFeedback.crossErrorReminder.threshold` | number | `3` | Recurring same-error count (across ≥2 approaches) that triggers a reminder |
| `toolFeedback.crossErrorReminder.cooldownMs` | number | `30000` | Minimum gap between reminders |
| `toolFeedback.failureBudget.enabled` | boolean | `true` | Inject a forceful steer when a single tool (by name) exhausts its per-turn failure budget |
| `toolFeedback.failureBudget.maxPerTurn` | number | `3` | Failures of one tool (by name) allowed in a turn before the steer fires |

### Engineering Style

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `engineeringStyle` | string | `"karpathy"` | Style pack appended to the system prompt's `Guidelines:` section. `"karpathy"` applies the Karpathy LLM-coding guideline bullets; `"default"` is a no-op. Unknown values resolve to `"karpathy"` |

### Time-Traveling Stream Rules (TTSR)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `ttsrRules` | array | `[]` | Off by default. Each rule: `{ name, regex, message, scope?, disabled? }`. On the first regex match against the model's stream the turn is aborted and `message` is injected before the retry. `scope` is `"assistant_text"` (default), `"tool_args"`, or `"any"` |

## Example

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "medium",
  "theme": "dark",
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  },
  "enabledModels": ["claude-*", "gpt-4o"],
  "warnings": {
    "anthropicExtraUsage": true
  },
  "packages": ["pi-skills"]
}
```

## Project Overrides

Project settings (`.pit/settings.json`) override global settings. Nested objects are merged:

```json
// ~/.pit/agent/settings.json (global)
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 16384 }
}

// .pit/settings.json (project)
{
  "compaction": { "reserveTokens": 8192 }
}

// Result
{
  "theme": "dark",
  "compaction": { "enabled": true, "reserveTokens": 8192 }
}
```
