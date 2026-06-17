# MCP servers

Pit registers tools, resources, and prompts from external Model Context Protocol
(MCP) servers. On session start Pit connects to every configured server in
parallel, fetches its catalog, and registers each tool with a name prefix so
multiple servers don't collide.

## Transports

Pit speaks all three MCP transports; the transport is usually inferred from the
config and can be set explicitly with `transport`:

| Transport | When | Inferred from |
|-|-|-|
| `stdio` | Local subprocess servers (the `@modelcontextprotocol/server-*` family, Desktop Commander, …) | a `command` is set |
| `http` | Remote Streamable-HTTP servers (a POST answers with JSON or an SSE stream) | a `url` is set (default) |
| `sse` | Legacy HTTP+SSE servers (a GET event channel + POST endpoint) | `transport: "sse"` |

## Configuration

MCP servers can be declared in several places (see **Scopes** below). The
`settings.json` form lives under `mcp.servers`; the standalone files use the
Claude-Code-compatible `{ "mcpServers": { … } }` shape so configs move between
the tools without translation.

```json
{
  "mcp": {
    "servers": {
      "github": {
        "url": "https://mcp.github.com/jsonrpc",
        "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" },
        "allowTools": ["search_issues", "get_pr"],
        "toolPrefix": "gh__"
      },
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}/work"],
        "env": { "LOG_LEVEL": "info" }
      },
      "legacy": { "transport": "sse", "url": "http://localhost:8788/sse" }
    }
  }
}
```

| Field | Type | Default | Description |
|-|-|-|-|
| `transport` | `"http"`\|`"sse"`\|`"stdio"` | inferred | Wire transport (see table above). |
| `url` | string | required for http/sse | JSON-RPC endpoint. |
| `command` | string | required for stdio | Executable to launch. |
| `args` | string[] | – | Arguments for `command`. |
| `env` | object | – | Extra env vars for the stdio subprocess (merged over the inherited env). |
| `cwd` | string | process cwd | Working directory for the stdio subprocess. |
| `headers` | object | – | Static headers (http/sse). Supports `${VAR}` / `${VAR:-default}` and `!command`. |
| `timeoutMs` | number | `30000` | Per-request timeout in ms. |
| `disabled` | boolean | `false` | Skip this server without removing the entry. |
| `allowTools` | string[] | – | Allowlist of tool names from this server. |
| `denyTools` | string[] | – | Denylist of tool names from this server. |
| `toolPrefix` | string | `"mcp__<name>__"` | Prefix applied to every tool name from this server. |
| `defer` | boolean | – | Per-server override of the deferral decision (see below). |
| `oauth` | object | – | OAuth 2.0 settings for a remote server (see **Authentication**). |

The two deferral knobs are global (siblings of `servers`):

| Field | Type | Default | Description |
|-|-|-|-|
| `defer` | `"auto"`\|`"always"`\|`"never"` | `"auto"` | How aggressively to keep MCP tool schemas off the active surface. `"auto"` defers a server only when it advertises at least `deferThreshold` tools. Requires tool discovery enabled. |
| `deferThreshold` | number | `10` | Tool count at or above which `defer: "auto"` defers a server. |

### Environment-variable interpolation

`url`, `command`, `args`, `headers`, and `env` values expand `${VAR}` and
`${VAR:-default}` (unset/empty → default), matching the `.mcp.json` ecosystem. A
whole value may also be `!command` to run a shell command and use its stdout.

## Scopes

Servers can be declared in five places. When the same name appears in more than
one, the strongest wins (weakest → strongest):

1. global `settings.json` → `mcp.servers` (user, all projects)
2. `<agentDir>/mcp.json` — **user** scope file
3. `<cwd>/.mcp.json` — **project** scope, committed/shared
4. project `.pit/settings.json` → `mcp.servers`
5. `<cwd>/.mcp.local.json` — **local** scope, gitignored (personal per-project)

`defer` / `deferThreshold` come from settings (project preferred over global).

## CLI

```
pit mcp list                          # show every configured server by scope
pit mcp get <name>                    # print one server's config
pit mcp add <name> <command|url> [args...] [--transport http|sse|stdio] [--scope local|project|user] [--header "K: V"] [--env K=V]
pit mcp add-json <name> '<json>'      # add from a raw JSON config
pit mcp remove <name> [--scope ...]
pit mcp enable|disable <name>
pit mcp import                        # merge servers from the Claude Desktop config into user scope
pit mcp authenticate <name>           # run the OAuth browser flow for a remote server
```

`add` defaults to the **local** scope. A `url` target → http (or `--transport sse`);
anything else → a stdio command.

## Tool name resolution

A server registered as `github` advertising `search_issues` is registered with
the LLM as `mcp__github__search_issues`. Override the prefix via `toolPrefix`.

Permission rules (`permissions.allowTools` / `denyTools`) accept `*`/`?` globs, so
a whole server can be gated at once: `"allowTools": ["mcp__github__*"]`.

## Resources and prompts

- **Resources** are reachable through two native tools, `list_mcp_resources` and
  `read_mcp_resource`, registered whenever any connected server advertises the
  resources capability. Output is capped like every other tool surface.
- **Prompts** are exposed as slash commands `/mcp__<server>__<prompt>`. Running
  one calls `prompts/get` and injects the server-rendered messages as a user
  turn; positional arguments map onto the prompt's declared arguments.

Resources and prompts are never deferred (they are few and pulled on demand).

## Deferral (keeping grab-bag servers off the prompt)

Every active tool's full JSON Schema is re-sent to the model each turn, so a
grab-bag server (Notion, Chrome, Desktop Commander — 17-25+ tools) is a large,
permanent token cost and destabilizes the cache prefix. Pit can **defer** such a
server's tools off the active surface into the tool-discovery index; the model
pulls them in on demand via `search_tool_bm25` (their parameter names and
descriptions are indexed so a query phrased after the arguments still ranks them).

Precedence: per-server `defer` → the legacy env `PIT_DEFER_MCP` (truthy forces
`"always"`) → the global `mcp.defer` policy. Small focused servers stay eager
under the default `"auto"`. Deferral needs tool discovery enabled.

## Reconnect behavior

When a call fails with a transport-class error (network / HTTP status / dead
subprocess / broken channel), Pit marks the connection broken and re-runs
`initialize` once (for stdio that re-spawns the subprocess; for http it drops the
stale session id; for sse it re-opens the channel) so the **next** call finds a
live session. The failed call itself is never re-sent — it may have side effects.
JSON-RPC application errors and user aborts leave the connection untouched. There
is no background reconnect loop.

Each MCP response body is capped (25 MB) and structurally crushed on overflow,
the only tool surface that could otherwise blow past the context budget.

## Inspection

`/mcp` lists every configured server, its connection state, and the tools it
advertises (deferred servers are flagged "deferred — discovered on demand"). The
dry-run report (`pit --dry-run`) also includes MCP servers and flags disabled
entries.

## Authentication

- **Static header** — set `Authorization` (or any header) in `headers`; supports
  `${VAR}` interpolation and `!command`.
- **OAuth 2.0** — for remote servers behind a browser flow, run
  `pit mcp authenticate <name>`. Pit discovers the authorization server
  (protected-resource → authorization-server metadata), registers a client
  dynamically when needed, runs the authorization-code + PKCE flow via a loopback
  callback, and stores the token in `<agentDir>/mcp-auth.json`. The token is
  attached automatically and refreshed before a reconnect when it expires. A
  static `Authorization` header takes precedence if both are set. Configure a
  pre-registered client or scopes via the `oauth` field
  (`clientId`, `clientSecret`, `authorizationServerUrl`, `scopes`).
```
