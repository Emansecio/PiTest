# CLAUDE.md

This file exists so that **any** assistant that looks for `CLAUDE.md` (Claude Code, etc.)
lands on the *same* rules as every other entry point — there is no separate "Claude"
ruleset. The single source of truth for this repo is **[`AGENTS.md`](AGENTS.md)**. Read it.

Whatever document you entered through, the canonical chain is the same:

- **[`AGENTS.md`](AGENTS.md)** — development rules, style, gate, git, TUI invariants. **The source of truth.**
- **[`docs/agents/already-built.md`](docs/agents/already-built.md)** — inventory of what the Pit already ships. **Read before proposing any improvement** (agents repeatedly re-propose existing features: caching, dedup, truncation, retry, "did you mean", idle timeout…).
- **[`docs/agents/prevention-layers.md`](docs/agents/prevention-layers.md)** — the layered guard pipeline (pre-model, pre-tool-call, post-tool-call, session) that already catches model errors, in execution order.
- **[`docs/CONTEXT.md`](docs/CONTEXT.md)** — domain glossary / project context.

Non-negotiables (full detail in `AGENTS.md`):
- Gate before done: `npm run check` (tsgo `erasableSyntaxOnly` + biome + vitest).
- Commit direct to `main`, whole repo, both remotes (`origin` + `pituned`) — only when asked.
- A suggestion to "add «basic mechanism» X" is almost certainly already built — check `already-built.md` first. Real value is *measure / generalize / resolve a trade-off*.

Do not treat this file as an independent ruleset. If anything here seems to differ from
`AGENTS.md`, `AGENTS.md` wins — and fix the drift.
