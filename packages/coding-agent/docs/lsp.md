# LSP

Pit ships a built-in `lsp` tool that talks to language servers over stdio.
Servers are auto-detected from the project, optionally overridden via config
files, and warmed in the background when a session starts.

## Auto-detect

On session start (when `lsp.enabled` is true), Pit loads built-in server
definitions and keeps only those that:

1. Are not marked `disabled` in an override file
2. Have at least one **root marker** present in the project cwd (e.g. `package.json`, `Cargo.toml`)
3. Have a **resolvable binary** — search order:
   - Project-local bins (`node_modules/.bin`, Python `.venv/bin` / `venv/bin` / `.env/bin`, and on Windows also `.venv/Scripts` / `venv/Scripts` / `.env/Scripts`, Ruby/Go `bin`, …)
   - `@pit/coding-agent`'s own `node_modules/.bin` (and the monorepo root hoist, when present)
   - `$PATH` (`which`)

Multiple servers may match the same file. Non-linter servers are preferred for
type intelligence (hover, go-to-definition, …); linters such as `biome` and
`eslint` still contribute diagnostics.

## TypeScript

`typescript-language-server` is an **optional dependency** of `@pit/coding-agent`.
When it installs successfully, auto-detect finds it via Pit's package bins even
if the user's project does not list it.

If the cwd looks like a JS/TS project (`package.json` / `tsconfig.json` /
`jsconfig.json`) but no non-linter server for `.ts`/`.tsx`/… was detected
(e.g. only `biome`), interactive mode shows a one-shot startup warning.

## Overrides (`lsp.json` / YAML)

Config files are searched in priority order (see [Settings → LSP](settings.md)).
Shapes:

```json
{
  "idleTimeoutMs": 300000,
  "servers": {
    "typescript": {
      "command": "typescript-language-server",
      "args": ["--stdio"],
      "disabled": false
    },
    "biome": {
      "disabled": true
    }
  }
}
```

A flat map of server name → config (without a `servers` wrapper) is also
accepted. Unknown fields on a server entry are ignored; known fields merge over
built-in defaults.

## Warmup and writethrough

- **Warmup:** after creating the session LSP manager, Pit calls `warmup()`
  fire-and-forget so servers initialize before the first `lsp` tool call.
  Failures are logged; the first tool use still cold-starts as needed.
- **Writethrough:** when `lsp.diagnosticsOnWrite` is true, diagnostics from a
  write/edit are attached to the tool result. `lsp.formatOnWrite` formats via
  the language server before writing.

## Process-global manager singleton

The active `LspManager` is published through a module singleton
(`setCurrentLspManager` / `getCurrentLspManager`), the same pattern as the
Chrome and eval-kernel managers. Dispose clears the singleton only when the
disposing session still owns it (`===`).

**Hazard:** starting a second session in the same process without disposing the
first overwrites the singleton. Pit records a `lsp.manager-overwrite` runtime
diagnostic (warn) when that happens; prefer one live session per process, or
always dispose before creating another manager.

## Tuning

| Variable | Effect | Default |
|----------|--------|---------|
| `PIT_LSP_SINGLE_DIAGNOSTICS_WAIT_MS` | Wait budget (ms) for single-file diagnostics in the `lsp` tool | `3000` |

See also [token-economy-tuning.md](../../../docs/token-economy-tuning.md).
