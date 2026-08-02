# Slash commands & keybindings

**Canonical docs:** `packages/coding-agent/docs/usage.md` (§ Slash Commands,
§ Message Queue, § Mouse, § CLI Reference) ·
`packages/coding-agent/docs/keybindings.md` (every action id and default).

## Slash commands

Type `/` in the editor for completion. Three other things also register as slash
commands: **skills** as `/<name>` (legacy `/skill:<name>` still accepted, gated by
`enableSkillCommands`), **prompt templates** as `/<templatename>`, and whatever
**extensions** register.

| Command | What it does |
|---|---|
| `/login`, `/logout` | OAuth or API-key credentials |
| `/model` | Switch model (Tab toggles the all/enabled ring filter) |
| `/settings` | Thinking level, theme, message delivery, transport |
| `/permission-mode <plan\|ask\|confirm\|auto>` | Switch Permission mid-session (`confirm` is off-cycle — only reachable here or via `--permission-mode`) |
| `/fusion` | Configure the Panel and enter Fusion orchestration |
| `/resume`, `/new`, `/name <name>`, `/session` | Session lifecycle and identity |
| `/tree`, `/fork`, `/clone` | Navigate, branch and duplicate the session |
| `/compact [prompt]` | Compact context now, optionally with instructions |
| `/memory` | Resolved memory file paths and contents |
| `/mcp` | Configured MCP servers, connection state, advertised tools |
| `/skills`, `/skills doctor [verbose\|fix]` | Loaded skills, duplicate trees, and settings-based fixes |
| `/goal` | Active autonomous goal: status, iterations, budget |
| `/reload` | Reload keybindings, extensions, skills, prompts, context files |
| `/export [file]`, `/share`, `/copy` | HTML export, private gist, clipboard |
| `/hotkeys`, `/mouse`, `/quit` | Shortcut list, mouse toggle, exit |

## Keybindings

Ids are namespaced (`tui.*` for editor/selection, `app.*` for the application);
pre-namespaced ids from old configs are migrated on startup. Customize in
`~/.pit/agent/keybindings.json` — one key or an array per action — then `/reload`
to apply without restarting.

```json
{
  "tui.editor.cursorUp": ["up", "ctrl+p"],
  "tui.input.newLine": ["shift+enter", "ctrl+j"]
}
```

Key format is `modifier+key` with `ctrl`, `shift`, `alt` combinable; letters,
digits, `escape`/`enter`/`tab`/`space`/arrows/`home`/`end`/`pageUp`/`pageDown`,
`f1`-`f12` and symbols.

The ones people ask about:

| Action id | Default | Effect |
|---|---|---|
| `app.permission.cycle` | `alt+p` | Cycle Mode: Plan → Ask → Auto → Fusion·Plan |
| `app.thinking.cycle` | `shift+tab` | Cycle thinking level |
| `app.thinking.toggle` | `ctrl+t` | Collapse/expand thinking blocks |
| `app.model.select` / `cycleForward` | `ctrl+l` / `ctrl+p` | Model picker / next model |
| `app.tools.expand` | `ctrl+o` | Collapse or expand tool output |
| `app.interrupt` | `escape` | Cancel / abort the turn |
| `app.clear` / `app.exit` | `ctrl+c` / `ctrl+d` | Clear editor / exit when empty |
| `app.editor.external` | `ctrl+g` | Open `$VISUAL` or `$EDITOR` |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` on Windows) | Paste image |
| `app.message.followUp` / `dequeue` | `alt+enter` / `alt+up` | Queue a follow-up / pull queued messages back |

`app.suspend` (`ctrl+z`) has no default binding on native Windows — terminals
there have no Unix job control. WSL behaves like Linux.

## Editor and message queue

`@` fuzzy-searches project files; Tab completes paths; Shift+Enter (Ctrl+Enter on
Windows Terminal) makes a new line; `!command` runs a shell command and sends the
output to the model, `!!command` runs it without sending.

While the agent is working, **Enter** opens an inline `[Send now] [Queue] [Cancel]`
chooser: *Send now* steers the message into the current turn (running tools are
cancelled so the next step boundary arrives immediately; during a Fusion turn it
degrades to a queued follow-up), *Queue* delivers it after all work finishes.
`PIT_NO_SEND_NOW=1` restores the legacy behavior where Enter queues directly.
Escape aborts and restores queued messages to the editor. Defaults for delivery
live in `steeringMode` / `followUpMode`.
