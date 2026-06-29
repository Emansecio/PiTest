# Pit — Development Rules

**This is the single source of truth for working in this repo.** `CLAUDE.md`,
and any other assistant entry point, point HERE — there is no separate ruleset.
If another doc seems to disagree, this file wins (and fix the drift).

Pit is a terminal coding agent. Monorepo packages: `@pit/ai` (provider/streaming
layer), `@pit/tui` (terminal UI framework), `@pit/coding-agent` (the product),
`@pit/agent-core` (agent loop core, npm package; dir `packages/agent`). The name is **Pit** — fix stray "Pi"/"pi-mono"
references when you touch a file that has them.

Per-turn rules live in this file. Task-specific reference material lives in
`docs/agents/` and is loaded on demand (pointers at the bottom). **Before proposing
improvements, read [`docs/agents/already-built.md`](docs/agents/already-built.md)
(what already ships) and [`docs/agents/prevention-layers.md`](docs/agents/prevention-layers.md)
(the guard pipeline).**

## Style

- Short, direct, technical prose. No emojis in commits, issues, PR comments, or code.
- Answer questions first, then edit/run.
- Ellipsis is always `…` (single char) in TUI strings.

## Code Quality

- Read files in full before wide-ranging changes or audits — search snippets are not enough.
- **Erasable TypeScript only** (checked by tsgo with `erasableSyntaxOnly`): no `enum`,
  no constructor parameter properties, no `namespace`/`module`, no `import =`/`export =`.
  Explicit fields + constructor assignments instead.
- No `any` unless unavoidable. No nested ternaries.
- **No inline/dynamic imports** — no `await import("./foo.js")`, no `import("pkg").Type`.
  Top-level imports only.
- No single-line helpers with a single call site — inline them.
- Check `node_modules` for external API types instead of guessing.
- Never downgrade code to silence type errors from stale dependencies; upgrade the dependency.
- Never hardcode key checks (`matchesKey(keyData, "ctrl+x")`). All keybindings go through
  the defaults objects (`DEFAULT_EDITOR_KEYBINDINGS` / `DEFAULT_APP_KEYBINDINGS`).
- Never edit `packages/ai/src/models.generated.ts` directly — change
  `packages/ai/scripts/generate-models.ts`.
- Do not preserve backward compatibility unless explicitly asked.
- Ask before deleting code that looks intentional.

## TUI Invariants

- Any composed line must go through `visibleWidth()` / `truncateToWidth()` — a rendered
  line wider than the terminal crashes the frame ("Rendered line exceeds terminal width").
  Emoji, CJK and ANSI sequences are why `string.length` is never the answer.
- Internal agent state (reflection, goal bookkeeping, etc.) must never leak into
  user-visible output.
- Tool call verbs are standardized: Ran / Read / Edited / Searched / Asked.

## Verification

- After code changes: `npm run check` — runs tsgo + biome + the coding-agent vitest
  suite + browser-smoke in parallel (`scripts/check-parallel.mjs`). Fix every error,
  warning and info. Read full output (start + end), not just the tail.
- Targeted tests, from the package root:
  `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`
- `@pit/tui` tests run under `node --test`, not vitest. `FORCE_COLOR` must be set at
  import time. On Windows, a vitest exit 1 cancels the rest of a batched command —
  run suspicious files individually.
- If you create or modify a test file, run that file and iterate until green.
- A timing-sensitive test that fails in the full suite but passes isolated is contention,
  not correctness — raise its `testTimeout` (the full parallel suite on Windows is slow).
- NEVER run: `npm run build`, `npm run release:*`.

### Test conventions

- `packages/coding-agent/test/suite/` uses `test/suite/harness.ts` + the faux provider.
  Never real provider APIs, real keys, or paid tokens.
- Issue regressions go in `packages/coding-agent/test/suite/regressions/` named
  `<issue-number>-<short-slug>.test.ts`.
- Ad-hoc scripts: write to a temp file, run, delete. No multi-line scripts inline in bash.

## Visual Output Verification

Any rendered visual artifact (HTML, CSS, SVG, canvas, UI component, chart) must be
verified visually BEFORE reporting done — `npm run check` proves it compiles, not that
it looks right.

1. Prefer the native `preview` tool: renders a URL/file/directory and returns a
   screenshot + console errors + failed requests in one call. For a dev server,
   start it and pass the URL.
2. Wait for settle; capture multiple frames for anything animated (`waitMs` for slow renders).
3. A `console.error` or failed request invalidates "done" even if pixels look right.
4. Review screenshots critically against the request — list concrete defects, iterate,
   cap at 2–3 cycles, report residual defects explicitly.

If no browser tool is reachable, say so and report the work as visually unverified.

## Browser Automation

- Prefer the native `chrome_devtools_*` tools (default-ON in the surface) for browsing,
  scraping, screenshots, forms. Fall back to other browser tools only when Chrome is
  unavailable or isolation is wanted.
- `pit --dry-run json` shows the active tool surface without booting a session.

## Git

- Commit and push **directly to main** — no feature branches, no PRs, unless explicitly
  asked otherwise.
- Commits include the whole intended change set for the task; when asked to "commit and
  push", include pre-existing uncommitted work in the tree as well (separate commit if
  it is unrelated).
- This repo is **multi-remote** (`pituned` + `github`): push to both and verify both
  accepted the push.
- Include `fixes #<n>` / `closes #<n>` when an issue applies.
- Never: `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash` over
  uncommitted work that is not yours, `git commit --no-verify`, force push.
- Do not commit unless asked.

## Existing features & quality filters (review before suggesting new ones)

**Before proposing ANY improvement, read [`docs/agents/already-built.md`](docs/agents/already-built.md).**
It's the curated, anchored inventory of what already ships (token/context economy,
the full tool set + native search backends, every quality guard, runtime robustness,
error recovery, providers, subagents) — built specifically because agents keep
re-proposing things that exist (caching, dedup, truncation, retry, "did you mean",
process-tree kill, idle timeout…). It also has a **"Where the frontier actually is"**
section: analyze from there. Litmus test: a suggestion to "add «basic mechanism» X"
is almost certainly redundant — the valuable work is *measure*, *generalize*, or
*resolve a trade-off*.

Quality guards already shipped (all in `packages/coding-agent/src/core/built-ins/`):
- Read guard, edit precondition, grounding firewall (symbol/import/path/pattern/bash), task rigor, permission mode, doom-loop & stagnation detectors, todo-first triage, learned-error guard, erasable-syntax preflight, destructive-command guard, patch audit, coordinator, MCP, hooks, memory.
- These run inside a fixed layered pipeline (pre-model → pre-tool-call → post-tool-call → session). The execution order and where each guard fires is mapped in [`docs/agents/prevention-layers.md`](docs/agents/prevention-layers.md) — read it before adding/changing a guard so you place it in the right band and don't duplicate an existing layer.

What does NOT exist (vaporware — don't propose fixes for it):
- **Diff-limit extension**: ADR-0002 proposed, never implemented. No code shipped.
- **scoped-models**: orphaned UI; the decision is to remove it, not extend it.
- **`pi-` services**: extension names like `pi-autoresearch`, `pi-subagents`, `@tintinweb/pi-tasks` are real npm packages, not Pit internals.

## Project tool config

`.pit/settings.json` (project-local, merged over global) only carries keys that
diverge from the defaults — currently `compaction.selfCorrection: false`.
`frequentFiles` and `toolDiscovery` are default-ON (no project opt-in needed).

Full surface and quirks: `docs/agents/tools-and-config.md`.

## Project docs (load on demand)

- `docs/agents/already-built.md` — **inventory of what already ships; read before proposing improvements.**
- `docs/agents/cli-animations.md` — **TUI motion subsystem: ticker, spinners, eases, reduced motion, improvement backlog.**
- `docs/agents/prevention-layers.md` — **the layered guard pipeline (pre/post model & tool call), in execution order.**
- `docs/RELEASING.md` — release process, CHANGELOG format, new-provider recipe.
- `docs/agents/pr-workflow.md` — PR review/merge flow, comment hygiene.
- `docs/agents/contribution-gate.md` — auto-gate workflows, `lgtm`/`lgtmi`, `pkg:*` labels.
- `docs/agents/tui-testing.md` — tmux recipe for driving the TUI headless.
- `docs/agents/tools-and-config.md` — `.pit/settings.json` shape and tool quirks.
- `docs/adr/` — architectural decision records.
