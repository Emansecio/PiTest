# Pit

**Pit** is a fork of [Pi](https://github.com/earendil-works/pi) ([pi.dev](https://pi.dev)) — a minimal, self-extensible coding-agent harness for the terminal.

This repository is maintained at [Emansecio/Pit](https://github.com/Emansecio/Pit). Upstream Pi remains the original project; Pit builds on that foundation with its own package names (`@pit/*`), CLI (`pit`), config dir (`.pit`), and product direction.

> **Upstream:** [earendil-works/pi](https://github.com/earendil-works/pi) · **Site (upstream):** [pi.dev](https://pi.dev)

## What you get

Interactive coding agent CLI plus the shared libraries behind it:

| Package | Description |
|---------|-------------|
| **[@pit/coding-agent](packages/coding-agent)** | Interactive coding agent CLI (`pit`) |
| **[@pit/agent-core](packages/agent)** | Agent runtime: tool calling and state management |
| **[@pit/ai](packages/ai)** | Unified multi-provider LLM API |
| **[@pit/tui](packages/tui)** | Terminal UI with differential rendering |

Pit keeps Pi’s extension model (TypeScript extensions, skills, prompt templates, themes, packages) and adds fork-specific work such as **Fusion** (multi-model panel + synthesis), stronger **permission / plan** gating, **LSP** integration, and related session/UX hardening. Domain terms are defined in [CONTEXT.md](CONTEXT.md).

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

Bug reports and features that belong in upstream Pi should go to the [Pi repository](https://github.com/earendil-works/pi). Changes specific to this fork belong here.

## License

MIT — same license family as upstream Pi.
