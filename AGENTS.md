# AGENTS.md — Pit project rules

Canonical source of truth for project-specific rules, for both human contributors
and coding agents working in this repository. Pit loads this file automatically at
startup when run from the repo root (disable with `--no-context-files`).

> Terminology: see [CONTEXT.md](CONTEXT.md) for the authoritative glossary
> (Mode, Permission, Orchestration, Fusion, Todo, Plan, Channel, Role). Do not
> redefine those terms here.

## Contribution rules

- **Understand your code.** If you cannot explain what your change does and how it
  interacts with the rest of the system, do not submit it. (See `CONTRIBUTING.md`.)
- **Core is minimal.** Features that do not belong in the core should be extensions.
  PRs that bloat the core are likely rejected.
- **Do not edit `CHANGELOG.md`.** Changelog entries are added by maintainers.
- **Run the gates before opening a PR:**
  - `npm run check` — full gate (biome + tsgo + vitest + smoke checks).
  - `./test.sh` — runs the suite without API keys (hermetic). On Windows: `./test.ps1`.
  - `npm run check:fast` — fast unit subset (excludes E2E/integration: chrome, dap,
    eval-kernel, resilience, shell-spawn suites); config in
    `packages/coding-agent/vitest.unit.config.ts`.
  - `npm run check:static` — lint/types/smokes only (`--no-vitest`); used by
    pre-commit so commits stay snappy. Pre-push runs full `npm run check`.
- **No destructive git resets** without explicit permission.

## Architecture at a glance

Monorepo (npm workspaces). Four packages:

- `@pit/ai` (`packages/ai`) — unified multi-provider LLM API (OpenAI, Anthropic, Google, …).
- `@pit/agent-core` (`packages/agent`) — agent runtime: tool calling and state management.
- `@pit/coding-agent` (`packages/coding-agent`) — interactive coding agent CLI.
- `@pit/tui` (`packages/tui`) — terminal UI library with differential rendering.

Turn flow: user input → `agent-session.ts` → `agent-loop.ts` → tool dispatch/execution
→ compaction check → provider call. Behavioral features live in built-in extensions,
not inline in `agent-session.ts` (see CONTEXT.md "Architectural Invariants").

## Documentation layout

- `docs/adr/` — architecture decision records.
- `docs/agents/` — agent-type docs and TUI/UX plans.
- `docs/reports/` — analysis and audit reports.
- `docs/optimization/`, `docs/plans/`, `docs/specs/`, `docs/superpowers/` — design docs.

## Environment / tuning

Token-economy tuning flags are documented in
[docs/token-economy-tuning.md](docs/token-economy-tuning.md). Do not add a new
`PIT_*` flag without documenting it there.
