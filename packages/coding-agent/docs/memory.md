# Persistent memory (MEMORY.md)

Some facts should outlive a single session: user preferences, project
conventions, gotchas discovered while debugging. Pi loads these from a
`MEMORY.md` file and injects them into the system prompt under a
`<persistent_memory>` block on every turn.

`MEMORY.md` is distinct from `AGENTS.md` / `CLAUDE.md`:

| File | Purpose | Scope | Editor |
|------|---------|-------|--------|
| `AGENTS.md` / `CLAUDE.md` | Project rules and conventions | You commit it | Humans |
| `MEMORY.md` | Long-lived notes the agent maintains | Usually `.gitignore`d | The agent (via `memory_append`) |

## Discovery

Pi looks in two scopes; both can coexist.

| Scope | Path (first match wins per scope) |
|-------|-----------------------------------|
| Global | `~/.pi/agent/memory/MEMORY.md`, then `~/.pi/agent/MEMORY.md` |
| Project | `.pi/memory/MEMORY.md`, then `MEMORY.md` at the project root |

Both files, when present, are injected — global first, project second.

## Format

`MEMORY.md` is plain Markdown. Pi doesn't enforce a structure, but the
`memory_append` tool adds entries in one of two formats:

- Bullet (no heading): `- (YYYY-MM-DD) entry text`
- H2 (with heading): `## Heading (YYYY-MM-DD)\n entry text`

Example:

```markdown
# Persistent Memory (project)

## Workflow (2026-05-20)
Always run `npm run check` before committing — pre-commit hook is missing.

- (2026-05-21) The `precompile` script must rerun after editing `loader.ts`.
- (2026-05-22) User prefers Portuguese for chat, English in code/comments.
```

## Writing

The agent invokes `memory_append`:

```jsonc
{
  "scope":   "project" | "global",
  "entry":   "Always run `npm run check` before committing",
  "heading": "Workflow"   // optional
}
```

The tool creates the directory and file as needed and prepends a date stamp.

## Settings

```json
{
  "memory": {
    "disableInjection": false
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `disableInjection` | `false` | Don't inject `MEMORY.md` into the system prompt. The `memory_append` tool still works — useful when you want to maintain a memory file but show it to the agent only on demand. |

## Inspection

`/memory` prints the resolved paths and contents. The dry-run report counts
discovered memory files.
