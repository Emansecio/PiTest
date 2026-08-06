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
| `/model` | Switch models (Tab toggles all/enabled ring filter) |
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
| `/fusion` | Multi-model panel mode: brainstorm with multiple models, then synthesize |
| `/memory` | Show resolved memory file paths and contents |
| `/permission-mode <mode>` | Switch permission mode (`plan`, `ask`, `confirm`, or `auto`) mid-session. `confirm` is only reachable here or via `--permission-mode` — it is not in the `alt+p` cycle |
| `/mcp` | List configured MCP servers, connection state, and advertised tools |
| `/goal` | Show active autonomous goal status, iterations, and budget usage |
| `/steer <message>` | Steer the active turn without interrupting it |
| `/todos` | Show the current todo list |
| `/pin [text or path]` | Pin a critical fact or file so it survives compaction (no args lists pins) |
| `/unpin <id>` | Remove a pin by id |
| `/plan` | Enter plan mode (read-only): research and build a plan, then `exit_plan` to execute |
| `/rewind` | Roll back files to an earlier turn (restores every file that turn touched) |
| `/jobs` | Background tasks: view output, kill (also `alt+j`) |
| `/theme` | Pick a color theme (live preview, Esc reverts) |
| `/mouse` | Toggle mouse behavior: click to position, drag to select+copy, right-click to copy |
| `/skills` | Skills catalog: `doctor`, `doctor fix`, `doctor verbose` |
| `/chrome` | Start/connect Chrome; add text before or after to run it in the browser |
| `/quit` | Quit pit |

> The exhaustive, always-current list is shown in-session by running `/help`. It merges built-in commands, loaded extensions, skills, and prompt templates, so it is the source of truth if your docs differ.

## Message Queue

You can submit messages while the agent is still working:

- **Enter** opens an inline chooser `[Send now] [Queue] [Cancel]`:
  - **Send now** (default) steers the message into the current turn for immediate reading: any tools still running are cancelled (their results come back aborted; the turn itself stays alive), so the next step boundary — and your message — arrives right away instead of waiting out a long tool. During a Fusion turn it degrades to a queued follow-up (no step boundary to inject into).
  - **Queue** delivers it as a follow-up after the agent finishes all work.
  - **Cancel** (or Esc, or just start typing) closes the chooser and keeps your text in the composer.
  - Navigate with ←/→/Tab; confirm with Enter. With mouse mode on (`/mouse`), clicking a button confirms it directly. Set `PIT_NO_SEND_NOW=1` to disable the chooser and have Enter queue a follow-up directly (legacy behavior).
- **Alt+Enter** queues a follow-up message directly (no chooser), delivered after the agent finishes all work.
- **Escape** aborts and restores queued messages to the editor.
- **Alt+Up** retrieves queued messages back to the editor.

On Windows Terminal, Alt+Enter is fullscreen by default. Remap it as described in [Terminal setup](terminal-setup.md) if you want pit to receive the shortcut.

Configure delivery in [Settings](settings.md) with `steeringMode` and `followUpMode`.

## Mouse

Mouse support is on by default (toggle with `/mouse`; `PIT_NO_MOUSE=1` is a hard kill-switch). With it on, a click can do everything its keyboard counterpart does:

- **Composer**: click places the cursor; drag selects; double-click selects a word.
- **Pickers and selectors** (`/model`, `/settings`, `/theme`, `/config`, the `ask` picker, …): clicking an item selects and confirms it in one gesture — submenus included. In multi-select `ask` prompts a click toggles the checkbox (Enter still submits).
- **Overlays**: clicks inside a modal overlay reach its contents; clicks outside are swallowed (the modal keeps focus).
- **Tool output**: clicking a tool's call title toggles its expanded output (the per-tool counterpart of Ctrl+O). Body lines stay unclaimed so you can still select output text natively.
- **File paths**: path-like inline code in assistant messages (e.g. `src/foo.ts:12`) renders as an OSC 8 `file://` hyperlink — open it with your terminal's own Ctrl+click, even with `/mouse` off.

Native terminal text selection stays available: the mouse wheel hands scrollback to the terminal, and a click on unclaimed content (transcript prose, blank areas) briefly suspends tracking so the next drag selects natively. Shift+drag always bypasses tracking.

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
| `--max-wall <seconds>` | Headless time budget: abort the in-flight turn at the limit and close with coherent partial state (exit 124); see [JSON mode](json.md#time-budget---max-wall) |
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
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `--models <patterns>` | Comma-separated patterns for Ctrl+P cycling |
| `--list-models [search]` | List available models |
| `--smol [model]` | Use the cheap sub-agent role (fast, low-cost model for fan-out) |
| `--slow [model]` | Use the deep-reasoning role (high-thinking model for complex work) |
| `--plan [model]` | Use the plan-mode read-only role |

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

`read` also handles non-text files: images (jpg, png, gif, webp) are sent as attachments, and **PDFs are converted to markdown** — detected by the `.pdf` extension or by the `%PDF-` magic bytes, so an extension-less PDF works too. The output starts with a short context line (`[PDF converted to markdown · TextBased · 12 pages]`) and `offset`/`limit` page through the converted markdown exactly like a text file. Extraction is text-layer only: **there is no OCR**, so a scanned or image-only PDF returns an explicit "no embedded text layer" message instead of an empty document. PDFs above the streaming threshold (10MB) are refused rather than buffered. Conversion is powered by `@firecrawl/pdf-inspector`, whose native binary ships prebuilt for Linux x64, macOS ARM64, and Windows x64; on any other platform `read` falls back to the old "binary file" note. Set `PIT_NO_PDF=1` to disable PDF conversion entirely.

Core built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `symbol`, `find_symbol`, `ask`, `todo`, `plan` (DAG-based structured plan), `calc` (arithmetic evaluator), `recipe` (task-runner abstraction), `repo_map` (project skeleton), `code` (code-mode VM), `ast_grep` (AST structural search), `ast_edit` (AST structural edit), `resolve` (stage/commit previews), `render_mermaid` (ASCII Mermaid diagrams), `inspect_image`, `search_skills`, `search_tool_bm25`, `recall_tool_output`, `goal_complete`, `message` (inter-agent messaging), `web_fetch` (URL → markdown; see [Fetching URLs](#fetching-urls)), `retain`/`recall`/`reflect`/`forget` (hindsight memory). Feature tools join the surface when their settings are enabled (most are on by default; see [Settings](settings.md)): `lsp`, `debug`, `eval`, `web_search`, `edit_v2` (hashline-based editing). Chrome DevTools tools and `preview` are activated for browser-oriented turns and remain discoverable through `search_tool_bm25`.

### Fetching URLs

`web_fetch` turns an arbitrary URL into readable markdown. It is read-only (a GET plus a text conversion), needs no API key, and is available in every Mode — including the read-only stances `Plan` and `Ask`. Use `web_search` to *find* a URL; use `web_fetch` once you have one.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `url` | string | — | Absolute `http:`/`https:` URL |
| `start_index` | number | `0` | Character offset into the converted document, for paging through long pages |

**Content types.** `text/html` (and `application/xhtml+xml`) is converted to markdown with boilerplate — `script`, `style`, `nav`, `header`, `footer`, `aside`, `form` — stripped; `text/*` and `application/json` are returned raw; PDFs and binary types are refused with an explicit message rather than a wall of bytes. Raw bodies are read up to 2MB and each request has a 15s budget. The **charset** is honoured: the `charset=` of the `Content-Type` header wins, otherwise HTML is prescanned for a `<meta charset>` / `<meta http-equiv="Content-Type">` declaration in its first 1KB, otherwise UTF-8 — so a latin-1 or Shift_JIS page reads correctly instead of as mojibake, and an unknown charset label degrades to UTF-8 rather than failing.

**Pagination.** Output is capped at ~24,000 characters per call. When a document is longer, the result ends with `[truncated at 24000 chars] continue with start_index=<n>` — call again with that `start_index` to read the next slice. The header line reports `chars <from>-<to>/<total>` whenever the result is a partial view.

**SSRF guard.** Only `http:`/`https:` are accepted, URLs carrying credentials (`user:pass@host`) are refused, and the hostname is resolved (A **and** AAAA) before any request: if *any* resolved address is loopback, private (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254/16`, which covers the `169.254.169.254` cloud-metadata endpoint), CGNAT, multicast/reserved, IPv6 unique-local (`fc00::/7`), `::1`, or `0.0.0.0/8`, the fetch is refused. Literal-IP hosts go through the same classification without DNS, including the IPv4-in-IPv6 (`::ffff:10.0.0.1`) and NAT64 forms. Redirects are followed manually (max 5 hops) and **every hop is re-validated**, so a public host cannot bounce you onto the metadata service. A DNS failure is also a refusal — the guard fails closed.

**Firecrawl fallback.** When the native path is bot-walled (HTTP 403/429/5xx), fails at the transport layer or times out, or returns HTML that converts to almost nothing (a JS-rendered app shell), `web_fetch` retries through Firecrawl's `v2/scrape` endpoint, which renders the page in a real browser. It works without credentials; set `FIRECRAWL_API_KEY` to use your own quota. A URL rejected by the SSRF guard is **never** sent to Firecrawl. Set `PIT_NO_FIRECRAWL=1` to disable the fallback and keep `web_fetch` on the native path only.

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
| `--permission-mode <mode>` | Permission mode for this run: `plan`, `ask`, `confirm` or `auto` (see [permissions.md](permissions.md)). `confirm` = `auto` with every uncovered mutation waiting for your approval; interactive only |
| `--allowlist-only` | Fail-closed (CI): never prompts, only `allowPaths` / `allowCommands` / `allowTools` run, everything else is denied. Orthogonal to `--permission-mode` |
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
| `PIT_NO_READ_DEDUPE` | Per-session de-dup of identical repeat reads is on by default; `1`/`true`/`yes` disables it (legacy alias: `PIT_READ_DEDUPE=0`) |
| `PIT_JSON_CRUSH` | Set to `1` to enable structural crushing of large JSON tool outputs |
| `PIT_DEFER_HISTORY` | Set to `1` to defer large historical tool outputs to a session store, recallable via `recall_tool_output` |
| `FIRECRAWL_API_KEY` | Optional bearer token for the `web_fetch` Firecrawl fallback. The fallback works without it; set it to use your own quota |
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
| `PIT_NO_PDF` | PDF → markdown conversion in `read`; PDFs fall back to the "binary file, not displayable as text" note |
| `PIT_NO_CODE_MODE` | The code-mode execution path |
| `PIT_NO_DEBUG_VERIFY` | The debug-driven verification gate |
| `PIT_NO_REFACTOR_TX` | The refactor-transaction staged multi-file edit primitive |
| `PIT_NO_LIVING_REPO_MAP` | The git-anchored incremental repo-map index |
| `PIT_NO_REPEATING_PATTERN` | The repeating-pattern (multi-tool cycle) doom-loop detector |
| `PIT_NO_STRUCTURAL_COMPACTION` | Structural-only compaction |
| `PIT_NO_SECRET_REDACT` | Secret redaction on egress |
| `PIT_NO_LEARNED_ERROR_GUARD` | The learned-error guard (blocks pre-exec calls matching a cross-session error pattern) |
| `PIT_NO_FIRECRAWL` | The `web_fetch` Firecrawl fallback (bot-walled or JS-rendered pages then fail natively instead of being retried through a real browser) |
| `PIT_NO_LEGACY_SKILLS` | Discovery of skills from legacy directories (`.claude/`, `.cursor/`, `.codex/`, `.gemini/`) |
| `PIT_NO_CLAUDE_CODE_SKILLS` | Loading skills from `~/.claude/skills/` (alias: `PIT_DISABLE_CLAUDE_CODE_SKILLS`) |
| `PIT_NO_BUNDLED_SKILLS` | Loading the skills shipped inside the pit package (`skills/`, e.g. `pit-knowledge`); see [Skills](skills.md#bundled-skills) |

### Advanced tuning

Optional knobs for power users. None require changes to work correctly — defaults are tuned for typical use.

| Variable | Default | Effect |
|----------|---------|--------|
| `PIT_SUBAGENT_MAX_DEPTH` | `1` | Maximum sub-agent nesting depth. `0` disables sub-agents entirely |
| `PIT_SUBAGENT_MAX_BYTES` | `4096` (4 KB) | Byte cap on the head+tail digest a sub-agent injects into the parent context; full output remains recoverable via `task({op:"read"})` |
| `PIT_BASH_AUTO_BACKGROUND_SECONDS` | `60` | Bash commands that run longer than this are automatically promoted to background jobs instead of being killed. Set to `0` to disable auto-backgrounding |
| `PIT_CODE_MODE_MAX_RESULT_BYTES` | `262144` (256 KB) | Byte cap on a single tool result re-injected into the code-mode VM |
| `PIT_FREQ_OUTLINE` | off | Set to `1` to enable the boot-outline heuristic: a symbol outline of the hottest frequent-files is appended to the system prompt each session |
| `PIT_ASYNC_REINJECT` | off | Set to `1` to auto-inject each async (`task` `op:"spawn"`) subagent result into the chat when it settles. Off by default (Claude Code parity): collect results via `op:"join"`/`op:"poll"` instead |
| `PIT_NARRATION` | off | Set to `1`, `true`, or `yes` to enable verbose narration in the system prompt (increases output tokens ~5×) |
| `PIT_PROACTIVE_PRUNE` | off | Set to `1` to proactively excerpt old large tool outputs from the live context once it crosses the floor below. Protects the 2 most recent turns |
| `PIT_PROACTIVE_PRUNE_FLOOR` | `64000` | Token floor below which proactive pruning is skipped (only used when `PIT_PROACTIVE_PRUNE=1`) |
| `PIT_KEY_COOLDOWN_MS` | `300000` | Milliseconds a rate-limited API key stays on cool-down before being retried |

The per-model fallback-chain cool-down (distinct from the per-key cool-down above) is adjustable via `settings.retry.cooldownMs` in `settings.json` (default: `300000` ms). This controls how long a failed model in a fallback chain is skipped before being retried.

## Design Principles

Pit keeps the core cohesive and pushes workflow-specific behavior into extensions, skills, prompt templates, and packages.

The core ships with native support for the workflows an agent needs every day: an MCP client (`mcp.servers` in [Settings](settings.md)), sub-agents (the `task` tool), to-do tracking (the `todo` tool), and a permission system with `plan`, `ask`, `confirm`, and `auto` modes (see [permissions.md](permissions.md)). These built-ins are implemented as extensions on the same APIs available to you — anything beyond them you can build or install as extensions, skills, prompt templates, or packages.

For the full rationale, read the [blog post](https://pituned.at/posts/2025-11-30-pi-coding-agent/).
