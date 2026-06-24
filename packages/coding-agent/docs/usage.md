# Using Pit

This page collects day-to-day usage details that do not fit on the quickstart page.

## Interactive Mode

<p align="center"><img src="images/interactive-mode.png" alt="Interactive Mode" width="600"></p>

The interface has four main areas:

- **Startup header** - shortcuts, loaded context files, prompt templates, skills, and extensions
- **Messages** - user messages, assistant responses, tool calls, tool results, notifications, errors, and extension UI
- **Editor** - where you type; border color indicates the current thinking level
- **Footer** - working directory, session name, token/cache usage, cost, context usage, and current model

The editor can be replaced temporarily by built-in UI such as `/settings` or by custom extension UI.

### Editor Features

| Feature | How |
|---------|-----|
| File reference | Type `@` to fuzzy-search project files |
| Path completion | Press Tab to complete paths |
| Multi-line input | Shift+Enter, or Ctrl+Enter on Windows Terminal |
| Images | Paste with Ctrl+V, Alt+V on Windows, or drag into the terminal |
| Shell command | `!command` runs and sends output to the model |
| Hidden shell command | `!!command` runs without sending output to the model |
| External editor | Ctrl+G opens `$VISUAL` or `$EDITOR` |

See [Keybindings](keybindings.md) for all shortcuts and customization.

## Slash Commands

Type `/` in the editor to open command completion. Extensions can register custom commands, skills are available as `/name` (the legacy `/skill:name` form is still accepted), and prompt templates expand via `/templatename`.

| Command | Description |
|---------|-------------|
| `/login`, `/logout` | Manage OAuth or API-key credentials |
| `/model` | Switch models |
| `/scoped-models` | Enable/disable models for Ctrl+P cycling |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/resume` | Pick from previous sessions |
| `/new` | Start a new session |
| `/name <name>` | Set session display name |
| `/session` | Show session file, ID, messages, tokens, and cost |
| `/tree` | Jump to any point in the session and continue from there |
| `/fork` | Create a new session from a previous user message |
| `/clone` | Duplicate the current active branch into a new session |
| `/compact [prompt]` | Manually compact context, optionally with custom instructions |
| `/copy` | Copy last assistant message to clipboard |
| `/export [file]` | Export session to HTML |
| `/share` | Upload as private GitHub gist with shareable HTML link |
| `/reload` | Reload keybindings, extensions, skills, prompts, and context files |
| `/hotkeys` | Show all keyboard shortcuts |
| `/quit` | Quit pit |

## Message Queue

You can submit messages while the agent is still working:

- **Enter** queues a steering message, delivered after the current assistant turn finishes executing its tool calls.
- **Alt+Enter** queues a follow-up message, delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want pit to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Sessions

Sessions are saved automatically to `~/.pit/agent/sessions/`, organized by working directory.

```bash
pit -c                  # Continue most recent session
pit -r                  # Browse and select a session
pit --no-session        # Ephemeral mode; do not save
pit --session <path|id> # Use a specific session file or session ID
pit --fork <path|id>    # Fork a session into a new session file
```

Useful session commands:

- `/session` shows the current session file and ID.
- `/tree` navigates the in-file session tree and can summarize abandoned branches.
- `/fork` creates a new session from an earlier user message.
- `/clone` duplicates the current active branch into a new session file.
- `/compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Context Files

Pit loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.pit/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System Prompt Files

Replace the default system prompt with:

- `.pit/SYSTEM.md` for a project
- `~/.pit/agent/SYSTEM.md` globally

Append to the default prompt without replacing it with `APPEND_SYSTEM.md` in either location.

## Exporting and Sharing Sessions

Use `/export [file]` to write a session to HTML.

Use `/share` to upload a private GitHub gist with a shareable HTML link.

If you use pit for open source work and want to publish sessions for model, prompt, tool, and evaluation research, see [`pituned/pi-share-hf`](https://github.com/pituned/pi-share-hf). It publishes sessions to Hugging Face datasets.

## CLI Reference

```bash
pit [options] [@files...] [messages...]
```

### Package Commands

```bash
pit install <source> [-l]     # Install package, -l for project-local
pit remove <source> [-l]      # Remove package
pit uninstall <source> [-l]   # Alias for remove
pit update [source|self|pit]   # Update pit and packages; skips pinned packages
pit update --extensions       # Update packages only
pit update --self             # Update pit only
pit update --extension <src>  # Update one package
pit list                      # List installed packages
pit config                    # Enable/disable package resources
```

These commands manage pit packages, not the pit CLI installation. To uninstall pit itself, see [Quickstart](quickstart.md#uninstall).

See [Pit Packages](packages.md) for package sources and security notes.

### Modes

| Flag | Description |
|------|-------------|
| default | Interactive mode |
| `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines; see [JSON mode](json.md) |
| `--mode rpc` | RPC mode over stdin/stdout; see [RPC mode](rpc.md) |
| `--export <in> [out]` | Export a session to HTML |

In print mode, pit also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | pit -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider, such as `anthropic`, `openai`, or `google` |
| `--model <pattern>` | Model pattern or ID; supports `provider/id` and optional `:<thinking>` |
| `--api-key <key>` | API key, overriding environment variables |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue the most recent session |
| `-r`, `--resume` | Browse and select a session |
| `--session <path\|id>` | Use a specific session file or partial UUID |
| `--fork <path\|id>` | Fork a session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode; do not save |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools |

Core built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `symbol`, `ask`, `todo`. Feature tools such as `lsp`, `debug`, `eval`, `web_search`, and the Chrome DevTools tools join the surface when their settings are enabled (most are on by default; see [Settings](settings.md)).

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load an extension from path, npm, or git; repeatable |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load a skill; repeatable |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load a prompt template; repeatable |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load a theme; repeatable |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable `AGENTS.md` and `CLAUDE.md` discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings. Example:

```bash
pit --no-extensions -e ./my-extension.ts
```

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt; context files and skills are still appended |
| `--append-system-prompt <text>` | Append to system prompt |
| `--verbose` | Force verbose startup |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include them in the message:

```bash
pit @prompt.md "Answer this"
pit -p @screenshot.png "What's in this image?"
pit @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Interactive with initial prompt
pit "List all .ts files in src/"

# Non-interactive
pit -p "Summarize this codebase"

# Non-interactive with piped stdin
cat README.md | pit -p "Summarize this text"

# Different model
pit --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix
pit --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
pit --model sonnet:high "Solve this complex problem"

# Limit model cycling
pit --models "claude-*,gpt-4o"

# Read-only mode
pit --tools read,grep,find,ls -p "Review the code"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `PIT_CODING_AGENT_DIR` | Override config directory; default is `~/.pit/agent` |
| `PIT_CODING_AGENT_SESSION_DIR` | Override session storage directory; overridden by `--session-dir` |
| `PIT_PACKAGE_DIR` | Override package directory, useful for Nix/Guix store paths |
| `PIT_OFFLINE` | Disable startup network operations, including update checks and package update checks |
| `PIT_SKIP_VERSION_CHECK` | Skip the Pit version update check at startup. This prevents the `pit.dev` latest-version request |
| `PIT_CACHE_RETENTION` | Set to `long` for extended prompt cache where supported |
| `PIT_DEFER_MCP` | `1`/`true`/`yes` forces every MCP server's tools into the tool-discovery index (same as `mcp.defer: "always"`) |
| `PIT_READ_DEDUPE` | Per-session de-dup of identical repeat reads is on by default; set to `0` to disable |
| `PIT_JSON_CRUSH` | Set to `1` to enable structural crushing of large JSON tool outputs |
| `PIT_DEFER_HISTORY` | Set to `1` to defer large historical tool outputs to a session store, recallable via `recall_tool_output` |
| `VISUAL`, `EDITOR` | External editor for Ctrl+G |
| `PIT_KEY_COOLDOWN_MS` | Cooldown in milliseconds before retrying a rate-limited API key (default: `300000` — 5 minutes). Applies to the per-key cool-down in the credential pool |

Feature kill-switches (all default-ON; set the variable to `1`/`true`/`yes` to disable):

| Variable | Disables |
|----------|----------|
| `PIT_NO_GROUNDING` | Symbol grounding — pre-exec resolution of a `debug` breakpoint name / `lsp` workspace-symbol query against the repo-map index + LSP workspace symbols |
| `PIT_NO_IMPORT_GROUNDING` | Import grounding — pre-exec check that a relative import specifier in a `write`/`edit` resolves on disk |
| `PIT_NO_PATH_GROUNDING` | Path grounding — pre-exec check that a `read`/`edit` target path exists |
| `PIT_NO_PATTERN_GROUNDING` | Pattern grounding — pre-exec structural balance-check of a `grep`/`find` regex/glob |
| `PIT_NO_EDIT_PRECONDITION` | The `edit` dry-run precondition check |
| `PIT_NO_CODE_MODE` | The code-mode execution path |
| `PIT_NO_DEBUG_VERIFY` | The debug-driven verification gate |
| `PIT_NO_REFACTOR_TX` | The refactor-transaction staged multi-file edit primitive |
| `PIT_NO_LIVING_REPO_MAP` | The git-anchored incremental repo-map index |
| `PIT_NO_REPEATING_PATTERN` | The repeating-pattern (multi-tool cycle) doom-loop detector |
| `PIT_NO_STRUCTURAL_COMPACTION` | Structural-only compaction |
| `PIT_NO_SECRET_REDACT` | Secret redaction on egress |
| `PIT_NO_LEARNED_ERROR_GUARD` | The learned-error guard (blocks pre-exec calls matching a cross-session error pattern) |
| `PIT_NO_LEGACY_SKILLS` | Discovery of skills from legacy directories (`.claude/`, `.cursor/`, `.codex/`, `.gemini/`) |
| `PIT_NO_CLAUDE_CODE_SKILLS` | Loading skills from `~/.claude/skills/` (alias: `PIT_DISABLE_CLAUDE_CODE_SKILLS`) |

### Advanced tuning

Optional knobs for power users. None require changes to work correctly — defaults are tuned for typical use.

| Variable | Default | Effect |
|----------|---------|--------|
| `PIT_SUBAGENT_MAX_DEPTH` | `1` | Maximum sub-agent nesting depth. `0` disables sub-agents entirely |
| `PIT_SUBAGENT_MAX_BYTES` | `24576` (24 KB) | Byte cap on the output a sub-agent injects into the parent context (tail is kept; full output stays in-memory) |
| `PIT_BASH_AUTO_BACKGROUND_SECONDS` | `60` | Bash commands that run longer than this are automatically promoted to background jobs instead of being killed. Set to `0` to disable auto-backgrounding |
| `PIT_CODE_MODE_MAX_RESULT_BYTES` | `262144` (256 KB) | Byte cap on a single tool result re-injected into the code-mode VM |
| `PIT_FREQ_OUTLINE` | off | Set to `1` to enable the boot-outline heuristic: a symbol outline of the hottest frequent-files is appended to the system prompt each session |
| `PIT_ASYNC_REINJECT` | off | Set to `1` to auto-inject each async (`task` `op:"spawn"`) subagent result into the chat when it settles. Off by default (Claude Code parity): collect results via `op:"join"`/`op:"poll"` instead |
| `PIT_NARRATION` | off | Set to `1` to enable verbose narration in the system prompt (increases output tokens ~5×) |
| `PIT_PROACTIVE_PRUNE` | off | Set to `1` to proactively excerpt old large tool outputs from the live context once it crosses the floor below. Protects the 2 most recent turns |
| `PIT_PROACTIVE_PRUNE_FLOOR` | `64000` | Token floor below which proactive pruning is skipped (only used when `PIT_PROACTIVE_PRUNE=1`) |
| `PIT_KEY_COOLDOWN_MS` | `300000` | Milliseconds a rate-limited API key stays on cool-down before being retried |

The per-model fallback-chain cool-down (distinct from the per-key cool-down above) is adjustable via `settings.retry.cooldownMs` in `settings.json` (default: `300000` ms). This controls how long a failed model in a fallback chain is skipped before being retried.

## Design Principles

Pit keeps the core cohesive and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

The core ships with native support for the workflows an agent needs every day: an MCP client (`mcp.servers` in [Settings](settings.md)), sub-agents (the `task` tool), to-do tracking (the `todo` tool), and a permission system with `plan` and `auto` modes (see [permissions.md](permissions.md)). These built-ins are implemented as extensions on the same APIs available to you — anything beyond them you can build or install as extensions, skills, prompt templates, or packages.

For the full rationale, read the [blog post](https://pituned.at/posts/2025-11-30-pi-coding-agent/).
