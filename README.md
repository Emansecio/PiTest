# Pit

**Pit** is a fork of [Pi](https://github.com/earendil-works/pi) ([pi.dev](https://pi.dev)) — a minimal, self-extensible coding-agent harness for the terminal.

This repository is maintained at [Emansecio/Pit](https://github.com/Emansecio/Pit). Upstream Pi remains the original project; Pit builds on that foundation with its own package names (`@pit/*`), CLI (`pit`), config dir (`.pit`), and product direction.

> **Upstream:** [earendil-works/pi](https://github.com/earendil-works/pi) · **Site (upstream):** [pi.dev](https://pi.dev)

Product and architecture areas (harness, context economy, guards, orchestration, …) are mapped in [Taxonomia.md](Taxonomia.md). Domain terms live in [CONTEXT.md](CONTEXT.md).

The unified Grok Build and AMP-inspired product proposal is documented in [GROK_PIT-AMPO.md](GROK_PIT-AMPO.md).

## What you get

Interactive coding agent CLI plus the shared libraries behind it:

| Package | Description |
|---------|-------------|
| **[@pit/coding-agent](packages/coding-agent)** | Interactive coding agent CLI (`pit`) |
| **[@pit/agent-core](packages/agent)** | Agent runtime: tool calling and state management |
| **[@pit/ai](packages/ai)** | Unified multi-provider LLM API |
| **[@pit/tui](packages/tui)** | Terminal UI with differential rendering |

## What Pit adds (vs upstream Pi)

High-signal deltas relative to upstream Pi, aligned with [Taxonomia.md](Taxonomia.md):

- **Improved harness** — stronger session/turn runtime: retry, abort, tool dispatch, and recovery as the “OS” around the model ([area: harness](Taxonomia.md#1-harness--runtime)).
- **Prevention layers** — stacked guards before/after tools and around the model (permissions, grounding, read-guard, doom-loop, verification, learned-error) so mistakes are blocked or repaired in-cycle ([area: guards](Taxonomia.md#5-guards--prevention), [prevention layers](docs/agents/prevention-layers.md)).
- **Native Chrome** — first-class browser tooling in the agent (Chrome DevTools / launcher), not bolted on as a generic MCP grab-bag ([area: tools](Taxonomia.md#4-tools)).
- **Modern compaction** — context economy beyond a single summarizer: prune, supersede, defer/recall, thinking cap, pre-send overflow, and token gates ([area: context economy](Taxonomia.md#3-context-economy)).
- **Fusion & multi-agent** — Mode = Permission × Orchestration; Fusion (panel + synthesizer), coordinator, and native subagents ([area: orchestration](Taxonomia.md#6-orchestration)).
- **Task cognition** — Todo-first triage, versioned Plan DAG with verify, and Goals with token budgets ([area: task cognition](Taxonomia.md#7-task-cognition)).
- **Memory & learning** — on-demand memory / hindsight and cross-session learned errors alongside session tree/branch ([area: memory](Taxonomia.md#8-memory--learning)).
- **LSP & search tooling** — language-server integration and richer search backends in the tools surface.

Pit still keeps Pi’s extension model (TypeScript extensions, skills, prompt templates, themes, packages).

## Requirements

- **Node.js `>=22.19.0`** (enforced via `engines` in `@pit/*` packages)

## Quick start

```bash
npm install -g @pit/coding-agent
```

Then in a project directory:

```bash
pit
```

Authenticate with `/login` for subscription providers, or set a provider API key (for example `ANTHROPIC_API_KEY`) before starting.

Package docs live under [`packages/coding-agent/docs/`](packages/coding-agent/docs/index.md).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Full gate: lint, typecheck, smoke checks, and tests
npm run check:fast   # Fast unit subset (excludes heavy E2E suites)
./test.sh            # Hermetic tests (Windows: ./test.ps1)
./pi-test.sh         # Run Pit from sources (from any directory)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Relationship to Pi

| | Pi (upstream) | Pit (this fork) |
|--|---------------|-----------------|
| Repo | [earendil-works/pi](https://github.com/earendil-works/pi) | [Emansecio/Pit](https://github.com/Emansecio/Pit) |
| npm scope | `@earendil-works/pi-*` | `@pit/*` |
| CLI | `pi` | `pit` |
| Config | `.pi` | `.pit` |
| Product map | upstream docs | [Taxonomia.md](Taxonomia.md) (12 areas) |

Bug reports and features that belong in upstream Pi should go to the [Pi repository](https://github.com/earendil-works/pi). Changes specific to this fork belong here.

## License

MIT — same license family as upstream Pi.
