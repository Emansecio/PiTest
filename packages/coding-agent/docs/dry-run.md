# Dry-run preview

`pit --dry-run` resolves settings, auth, resources, MCP servers, hooks, and
permissions, prints a readiness report, and exits without running the agent
loop. It never calls the model provider, never spawns hook processes, and
never opens a network connection to MCP servers.

Useful as:

- A pre-flight check before kicking off a long agentic loop.
- A CI diagnostic when "pit works on my machine but not on the runner".
- A bug report attachment.

## Usage

```bash
pit --dry-run            # text format (default)
pit --dry-run text       # explicit text
pit --dry-run json       # machine-readable JSON
```

Combine with the usual flags to inspect a specific configuration:

```bash
pit --dry-run --provider openai --model gpt-4o --tools read,bash
pit --dry-run --permission-mode plan
```

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | All checks `ready` or `warning` |
| `1` | At least one check `blocked` (most commonly: no model resolved, or missing auth) |

## Checks performed

| Check | Possible states | What "blocked" means |
|-------|-----------------|----------------------|
| Working directory | ready / blocked | `cwd` does not exist |
| Agent directory | ready / warning | warning when the directory will be created on first write |
| Settings | ready / warning | warning when a settings file failed to parse |
| Model & auth | ready / blocked | no model selected, or no API key / OAuth for selected model |
| Tools | ready / warning | warning when no tools are enabled |
| Extensions | ready / warning | warning when any extension failed to load |
| Resources | ready | counts skills, prompts, themes |
| Memory | ready | counts MEMORY.md files |
| MCP servers | ready / warning | warning when a server is `disabled` |
| Hooks | ready | counts hooks per event |
| Permissions | ready | reports mode + rule counts |
| Project context | ready | counts AGENTS.md / CLAUDE.md |

## JSON output

The JSON form mirrors the `DryRunReport` interface in
`src/cli/dry-run/index.ts`:

```ts
interface DryRunReport {
  cwd: string;
  agentDir: string;
  overallStatus: "ready" | "warning" | "blocked";
  checks: Array<{
    name: string;
    status: "ready" | "warning" | "blocked";
    detail: string;
    items?: Array<{ label: string; value: string; status?: "ready" | "warning" | "blocked" }>;
  }>;
}
```

Useful in CI:

```bash
status=$(pit --dry-run json | jq -r '.overallStatus')
[ "$status" = "ready" ] || exit 1
```

## Notes

- `PIT_DRY_RUN=1` is exported automatically when `--dry-run` is set, so
  built-in extensions (notably MCP) can short-circuit any side effects.
  Custom extensions can read the same env var to behave the same way.
- Dry-run still loads every extension (factory functions run). Extensions
  that do network I/O at load time should check `process.env.PIT_DRY_RUN`.
