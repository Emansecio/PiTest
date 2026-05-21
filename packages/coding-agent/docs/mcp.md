# MCP servers

Pi can register tools from external Model Context Protocol (MCP) servers over
HTTP. Each configured server is reachable at a JSON-RPC 2.0 endpoint; on
session start Pi initializes every server in parallel, fetches its tool
catalog, and registers each tool with a name prefix so multiple servers don't
collide.

> The MCP spec also defines stdio and SSE transports. Pi currently ships only
> HTTP. SSE responses are rejected with a clear error message so you don't
> silently hang.

## Configuration

```json
{
  "mcp": {
    "servers": {
      "github": {
        "url": "https://mcp.github.com/jsonrpc",
        "headers": { "Authorization": "Bearer ${GITHUB_MCP_TOKEN}" },
        "timeoutMs": 30000,
        "allowTools": ["search_issues", "get_pr"],
        "denyTools": [],
        "toolPrefix": "gh__"
      },
      "internal-search": {
        "url": "http://localhost:8787/mcp",
        "disabled": false
      }
    }
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `url` | string | required | JSON-RPC 2.0 HTTP endpoint. |
| `headers` | object | – | Static headers added to every request. Use plain strings; env-var interpolation is the caller's responsibility. |
| `timeoutMs` | number | `30000` | Per-request timeout in ms. |
| `disabled` | boolean | `false` | Skip this server without removing the entry. |
| `allowTools` | string[] | – | Allowlist of tool names from this server. When set, tools not in the list are hidden. |
| `denyTools` | string[] | – | Denylist of tool names from this server. |
| `toolPrefix` | string | `"<name>__"` | Prefix applied to every tool name from this server when registering with Pi. Avoids collisions across servers. |

## Tool name resolution

Given a server registered as `github` advertising a `search_issues` tool, Pi
registers it with the LLM as `github__search_issues`. Override the prefix via
`toolPrefix`.

## Reconnect behavior

When `tools/call` fails with a network-class error, Pi marks the connection
broken, re-runs `initialize`+`tools/list` once, then retries the original
call. If reconnect succeeds the call retries; if not, the original error
propagates. There is no background reconnect loop — failures surface
immediately on the next call.

## Inspection

`/mcp` lists every configured server, its connection state, and the tools it
advertises. The dry-run report (`pi --dry-run`) also includes MCP servers and
flags disabled entries.

## Authentication

MCP itself doesn't standardize auth. Most public servers accept an
`Authorization` header — set it in `headers`. For provider-issued tokens
that rotate, run a wrapper command that refreshes the token and edits
`settings.json` before launching Pi.
