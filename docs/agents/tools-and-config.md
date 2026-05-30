# Project tool config & quirks

> Loaded on demand. The per-turn rules in `AGENTS.md` already cover the
> load-bearing behavior; this doc explains the optional knobs and the few
> idiosyncrasies of working inside `pi-mono`.

## `.pit/settings.json`

`SettingsManager` reads `<cwd>/.pit/settings.json` and merges it OVER the global
settings file in the agent dir (typically `~/.pit/settings.json`). Anything you
put here is project-local and only active when an agent runs inside this repo.

Live shape: see `Settings` in
`packages/coding-agent/src/core/settings-manager.ts`. The fields most worth
knowing for token-efficient operation:

| Field | Effect |
|-|-|
| `frequentFiles.enabled` | Tracks per-file read/edit/write counts and surfaces the hottest paths in the system prompt. Persisted across sessions in `<cwd>/.pit/frequent-files.json` so a new session boots warm (no re-discovery via repeated reads). |
| `frequentFiles.topN` / `minHits` | How many entries to surface, and the floor that filters one-touch noise. |
| `toolDiscovery.enabled` | When `true` (default), tools NOT in the coding bundle are hidden behind `search_tool_bm25`. Keeps the per-turn tool snippet block short while leaving everything discoverable on demand. |
| `toolDiscovery.alwaysActive` | Force-includes tools by name on the active surface even if they would otherwise be hidden. |
| `toolDiscovery.hiddenByDefault` | Explicitly hide named tools regardless of the bundle delta. |
| `engineeringStyle` | `"default"` (no-op) or `"karpathy"` (assumptions, simplicity, surgical edits, goal-driven execution). See `docs/adr/0004-karpathy-engineering-style.md`. |
| `compaction.keepRecentTokens` | Floor for "recent context" preserved verbatim through compaction. |

This repo ships a minimal template at `.pit/settings.json`. Override anything
there by editing that file; nothing here is load-bearing.

## Tool quirks in this repo

These are project-specific facts about how tools behave inside `pi-mono`. Each
saves a class of tool-call errors:

- **Vitest path**: `npx tsx ../../node_modules/vitest/dist/cli.js --run
  test/specific.test.ts` — run from the package root, not the repo root.
- **`npm run check`**: full output, no tail. Fix all errors, warnings, and
  infos. It does NOT run tests.
- **NEVER run from an agent loop**: `npm run build`, `npm test`, `npm run
  release:*`, anything that bumps versions or publishes.
- **Erasable TypeScript only** in src/test under the root tsconfig: no `enum`,
  `namespace`, `import =`, parameter properties — Node strip-only mode is the
  bar.
- **Generated files**: `packages/ai/src/models.generated.ts` is a build
  artifact — edit `packages/ai/scripts/generate-models.ts` instead.
- **No inline imports**: no `await import("./foo.js")`, no
  `import("pkg").Type` in type positions. Top-level imports only.
- **`pi-chrome` first** for any browser-driven task. Falls back to
  `playwright` / `chrome-devtools-mcp` only when explicitly authorized or the
  bridge is unavailable.
- **Tests**: faux provider + `test/suite/harness.ts` only for
  `packages/coding-agent/test/suite/`. Never real provider APIs or paid
  tokens.
- **Issue-pinned regressions**: file under
  `packages/coding-agent/test/suite/regressions/` as
  `<issue-number>-<short-slug>.test.ts`.
