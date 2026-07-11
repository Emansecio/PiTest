<p align="center">
  <a href="https://pit.dev">
    <img alt="Pit logo" src="https://pit.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>
<p align="center">
  <a href="https://pit.dev">pit.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Pit Agent Harness Mono Repo

## Requirements

- **Node.js `>=22.19.0`** (enforced via `engines` in all `@pit/*` packages)

This is the home of the Pit agent harness project including our self extensible coding agent.

* **[@pit/coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@pit/agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@pit/ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about Pit:

* [Visit pit.dev](https://pit.dev), the project website with demos
* [Read the documentation](https://pit.dev/docs/latest), but you can also ask the agent to explain itself

## Share your OSS coding agent sessions

If you use Pit or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/pitunedgames/status/2037811643774652911).

To publish sessions, use [`pituned/pi-share-hf`](https://github.com/pituned/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/pitunedgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [pitunedgames/pi-mono on Hugging Face](https://huggingface.co/datasets/pitunedgames/pi-mono)

## All Packages

| Package | Description |
|---------|-------------|
| **[@pit/ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@pit/agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@pit/coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@pit/tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Full gate: lint, typecheck, smoke checks, and coding-agent tests
npm run check:fast   # Fast unit subset (excludes E2E: chrome, dap, eval-kernel, resilience)
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run Pit from sources (can be run from any directory)
```

## License

MIT
