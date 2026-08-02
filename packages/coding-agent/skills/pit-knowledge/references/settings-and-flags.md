# Settings & flags

**Canonical docs:** `packages/coding-agent/docs/settings.md` (every key, with
defaults) · `docs/token-economy-tuning.md` (the full `PIT_*` catalog for the
context-economy pipeline, with the file each flag is read in) ·
`packages/coding-agent/docs/usage.md` (§ Environment Variables, kill-switches,
advanced tuning).

## Where settings live

| File | Scope |
|---|---|
| `~/.pit/agent/settings.json` | Global (all projects) |
| `.pit/settings.json` | Project (current directory) |

Project overrides global. Resource paths resolve relative to the file's own
directory (`~/.pit/agent` or `.pit`); absolute paths and `~` work. `/settings`
edits the common options interactively; everything else is edited by hand.

## The setting groups (index of `settings.md`)

Model & thinking (incl. `thinkingBudgets`, model roles) · UI & display · update
checks · warnings · **compaction** · branch summary · retry · message delivery
(`steeringMode`, `followUpMode`) · minimal tool surface · terminal & images ·
shell · sessions · model cycling · markdown · **resources** (`packages`,
`extensions`, `skills`, `prompts`, `themes`, `enableSkillCommands`,
`skillDiscovery`) · **permissions** · hooks · **MCP servers** · memory ·
verification · pending checks · eval · **fusion** · grep/find backend · ast_grep
backend · LSP · debug (DAP) · Chrome DevTools · web search · hindsight memory ·
frequent files · **tool discovery** · agent messaging · **tool feedback**
(doom-loop, stagnation, cross-error, failure budget, todo cadence) ·
engineering style · autonomous goal · TTSR rules.

When answering "how do I turn X off", look for the group above first — most
subsystems are `X.enabled: false`.

## `PIT_*` environment flags

Three families:

1. **Kill-switches** — `PIT_NO_*`, all default-ON features; set to `1`/`true`/`yes`
   to disable. Examples: `PIT_NO_GROUNDING`, `PIT_NO_CODE_MODE`,
   `PIT_NO_SECRET_REDACT`, `PIT_NO_LIVING_REPO_MAP`, `PIT_NO_LEGACY_SKILLS`,
   `PIT_NO_CLAUDE_CODE_SKILLS`, `PIT_NO_BUNDLED_SKILLS`, `PIT_NO_MOUSE`,
   `PIT_NO_SEND_NOW`. Listed in `usage.md`.
2. **Token-economy tuning** — ratios, floors and prune/defer switches for
   compaction and context pruning. Documented one-per-row (effect, default, file,
   truthy convention) in `docs/token-economy-tuning.md`. Repo rule: **no new
   `PIT_*` flag lands without a row there.**
3. **Environment/config** — `PIT_CODING_AGENT_DIR`, `PIT_CODING_AGENT_SESSION_DIR`,
   `PIT_PACKAGE_DIR`, `PIT_OFFLINE`, `PIT_SKIP_VERSION_CHECK`,
   `PIT_CACHE_RETENTION`, `PIT_KEY_COOLDOWN_MS`, …

Truthy parsing is `isTruthyEnvFlag`: `"1"`, `"true"`, `"yes"` (case-insensitive).
So `PIT_NO_X=0` / `=false` does **not** opt out. Numeric flags parse via `Number`
and are marked as such in the catalog.

## Flag vs. setting: who wins

A handful of flags shadow a settings key, and the precedence is not uniform —
`settings.md` § Environment overrides tabulates each pair. The three shapes are:

- **Setting wins, env is only the fallback default** (e.g. `PIT_CLEAR_ON_SHRINK`,
  `PIT_HARDWARE_CURSOR`).
- **Env wins outright** (e.g. `PIT_NO_PENDING_CHECKS`, `PIT_GREP_ENGINE`,
  `PIT_NO_CHROME_DEVTOOLS`).
- **OR — either one opts out** (e.g. `PIT_NO_CLAUDE_CODE_SKILLS` ↔
  `skillDiscovery.noClaudeCode`, `PIT_NO_LEGACY_SKILLS` ↔ `skillDiscovery.noLegacy`).

Never state a precedence from memory; quote the table.

## Compaction knobs most often asked about

`compaction.reserveTokens` (default `16384`) and `compaction.keepRecentTokens`
(default `20000`), both scaling with large context windows. The trigger stack
itself is described in `packages/coding-agent/docs/compaction.md`.
