# Sessions, context & extensibility

**Canonical docs:** `packages/coding-agent/docs/sessions.md` ·
`packages/coding-agent/docs/compaction.md` · `packages/coding-agent/docs/memory.md` ·
`packages/coding-agent/docs/usage.md` (§ Context Files) ·
`packages/coding-agent/docs/skills.md` · `.../extensions.md` · `.../mcp.md` ·
`.../packages.md` · `.../hooks.md` · `.../session-format.md` (JSONL format).

## Sessions

Auto-saved to `~/.pit/agent/sessions/`, organized by working directory; each
session is a **JSONL file with a tree structure** — branches are kept, not
overwritten.

`pit -c` continues the most recent · `pit -r` opens the picker ·
`pit --session <path|id>` targets one (partial UUIDs work) · `pit --fork <path|id>`
forks into a new file · `pit --no-session` runs ephemeral.

In-session: `/session` (file, id, messages, tokens, cost), `/tree` (navigate the
tree and continue from any point), `/fork` (new session from an earlier user
message), `/clone` (duplicate the active branch), `/name`, `/export`, `/share`.

Note when explaining `/session` numbers: token and cost totals are *lifetime* —
they include compacted-away context and inactive branches — while message and
tool counts describe the currently materialized context. Compacting or navigating
lowers the counts without erasing consumption.

## Compaction

Not one threshold but a **stack of layers**:

| Layer | Trigger | LLM summarizer |
|---|---|---|
| Hard threshold | `contextTokens > contextWindow − effectiveReserve` (+ ~8k hysteresis) | yes (sync) |
| Soft / predictive background | Approaching the hard threshold at end of turn | yes (async, joined before the next prompt) |
| Presend overflow | Full wire estimate exceeds a dynamic ratio (~0.95 → ~0.88 under pressure) | yes |
| Overflow recovery | Provider context-overflow error | yes (+ one retry) |
| Mid-turn pressure | Wire pressure between tool rounds (~92%) | no (prune only) |
| Proactive / live supersede | Above the proactive floor, or obsolete reads/greps after successful tools | no (prune only) |
| Manual | `/compact [instructions]`, RPC `compact` | yes |

Defaults: `reserveTokens` 16384, `keepRecentTokens` 20000 (both scale with large
windows). Mechanics: find the cut point walking back until `keepRecentTokens`,
summarize everything before it into a `CompactionEntry` with a `firstKeptEntryId`,
reload from summary + kept messages. **Branch summarization** is the sibling
mechanism, triggered by `/tree` navigation. Right after a compaction the footer's
`CTX` is a `~`-marked structural estimate until the next provider response
confirms occupancy.

## What Pit reads into the prompt

- **Context files** — `AGENTS.md` or `CLAUDE.md` from `~/.pit/agent/`, from every
  ancestor directory, and from the cwd. Human-written project rules. Disable with
  `--no-context-files` / `-nc`.
- **`MEMORY.md`** — long-lived notes the *agent* maintains (`memory_append`),
  injected as `<persistent_memory>`. Global `~/.pit/agent/memory/MEMORY.md` then
  `~/.pit/agent/MEMORY.md`; project `.pit/memory/MEMORY.md` then `MEMORY.md` at
  the root. Both scopes inject (global first). `/memory` shows what resolved;
  `memory.disableInjection` keeps the file but stops the injection.
- **System prompt** — replace with `.pit/SYSTEM.md` (project) or
  `~/.pit/agent/SYSTEM.md` (global); extend with `APPEND_SYSTEM.md` in either
  location, or `--system-prompt` / `--append-system-prompt`.

## Extensibility (the core stays small)

| Mechanism | What it adds | Where it lives |
|---|---|---|
| **Extensions** | TypeScript modules: tools, commands, events, custom UI | `~/.pit/agent/extensions/`, `.pit/extensions/`, `-e <source>` |
| **Skills** | On-demand instruction packages (`SKILL.md` + assets) | `~/.pit/agent/skills/`, `.pit/skills/`, package `skills/`, `--skill <path>` |
| **Prompt templates** | Reusable prompts expanded from `/<name>` | `~/.pit/agent/prompts/`, `.pit/prompts/` |
| **Themes** | Terminal color themes | `~/.pit/agent/themes/`, `.pit/themes/` |
| **Packages** | npm/git bundles of the above | `packages` in settings, `pit install` |
| **MCP servers** | External tools/resources/prompts, namespaced `mcp__<server>__` | `mcp.servers` in settings, or Claude-Code-compatible `mcpServers` files |
| **Hooks** | Shell commands on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `PreCompact` | `hooks` in settings |

Skills use progressive disclosure: the prompt carries a compact retrieval hint
plus up to three per-turn cards; the model then calls `search_skills` and reads
the matching `SKILL.md`. `/reload` re-scans keybindings, extensions, skills,
prompts and context files without restarting. `/skills doctor` explains duplicate
skill trees and can opt out of them in settings.

## Channels

The same agent is consumed through four **Channels**: `interactive` (the TUI),
`text` (`-p`/`--print`), `json` (`--mode json`) and `rpc` (`--mode rpc`), plus the
Node SDK. Channel is *not* Mode: in the non-interactive channels a mutating action
under `plan`/`ask` is denied outright rather than prompting.
