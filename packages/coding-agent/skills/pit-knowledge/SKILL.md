---
name: pit-knowledge
description: Answers questions about Pit itself — Modes and permissions (plan / ask / auto / fusion), what the built-in tools do and how tool discovery works, settings.json keys, PIT_* environment flags and kill-switches, slash commands, keybindings, sessions, compaction, context files, skills, extensions and MCP. Use whenever the user asks how Pit behaves, why a tool call was blocked, which mode they are in, where a setting lives, what a flag does, or how to configure the agent — instead of answering from memory.
license: MIT
---

# Pit self-knowledge

Pit is a terminal coding agent with a deliberately minimal core: the loop, the
tools and the guards live in the core; almost everything else arrives as
extensions, skills, prompt templates, themes or packages.

This skill is an **index with summaries**, not a copy of the manual. Every
reference below names the canonical document; when that document is reachable
(a Pit checkout, or `docs/` inside the installed package) read it before
answering anything version-sensitive. If a fact is in neither, say so instead of
inventing a setting or a flag.

## Answer these from the reference, not from memory

| Question shape | Read |
|---|---|
| "what mode am I in", "why was my `edit` blocked", "what does plan/ask/auto do", "how does Fusion work" | [references/modes-and-permissions.md](references/modes-and-permissions.md) |
| "which tools exist", "what does `symbol`/`repo_map`/`code` do", "why can't I see tool X", "how do I limit the tool surface" | [references/tools.md](references/tools.md) |
| "where do settings live", "what is `PIT_*`", "how do I turn off Y" | [references/settings-and-flags.md](references/settings-and-flags.md) |
| "which slash commands exist", "what is the shortcut for Z", "how do I rebind a key" | [references/commands-and-keys.md](references/commands-and-keys.md) |
| "how are sessions stored", "when does compaction run", "what is AGENTS.md/MEMORY.md", "how do skills/extensions/MCP load" | [references/sessions-and-context.md](references/sessions-and-context.md) |

## The four facts worth knowing without opening anything

1. **Mode = Permission × Orchestration.** The cycle key (`alt+p`) walks a
   4-stop loop, not the cross-product: `Plan → Ask → Auto → Fusion · Plan → Plan`.
2. **`plan` and `ask` are enforced identically** — both read-only. What differs
   is the stance: `plan` researches and returns a plan for approval; `ask`
   answers the question directly and tells you to switch modes for edits.
3. **`auto` is the default and is *guarded*,** not unrestricted: writes and
   commands run without prompting, but a built-in deny floor (`.env`, `~/.ssh/**`,
   `rm -rf /`, …) is a hard block.
4. **Orchestration `fusion` always rides Permission `plan`** — there is no
   `Fusion · Ask` and no `Fusion · Auto`.

## Working rules for this skill

- Terminology is fixed by `CONTEXT.md` in the repo root (Mode, Permission,
  Orchestration, Fusion, Panel, Synthesizer, Channel, Role, Todo, Plan). Use
  those words; do not say "permission mode" for the whole stance, or "fusion
  mode" as if it were a permission level.
- Product/architecture areas are mapped in `Taxonomia.md` (12 areas). Useful when
  the question is "where does this belong".
- When a user asks *how to change* behavior, prefer the settings key over the env
  flag, and say which one wins — the precedence differs per pair and is tabulated
  in `packages/coding-agent/docs/settings.md` (§ Environment overrides).
