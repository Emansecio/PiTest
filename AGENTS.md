# Development Rules

Per-turn rules live in this file. Reference material that only matters for
specific tasks lives in `docs/agents/` and is loaded on demand. See the
"Project docs" pointers at the bottom.

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")
- When the user asks a question, answer it first before making edits or running implementation commands.

## Code Quality

- Read files in full before making wide-ranging changes, before editing files you have not already fully inspected, and when the user asks you to investigate or audit something. Do not rely only on search snippets for broad changes.
- No `any` types unless absolutely necessary
- Single-line helper functions with a single call site are forbidden; inline them instead.
- Check node_modules for external API type definitions instead of guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic imports for types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Use only erasable TypeScript syntax compatible with Node strip-only mode in TypeScript checked by the root config (`packages/*/src`, `packages/*/test`, and `packages/coding-agent/examples`). Do not use constructor parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other TypeScript constructs that require JavaScript emit. Use explicit fields and constructor assignments instead of parameter properties.
- Always ask before removing functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it
- Never hardcode key checks with, eg. `matchesKey(keyData, "ctrl+x")`. All keybindings must be configurable. Add default to matching object (`DEFAULT_EDITOR_KEYBINDINGS` or `DEFAULT_APP_KEYBINDINGS`)
- NEVER modify `packages/ai/src/models.generated.ts` directly. Update `packages/ai/scripts/generate-models.ts` instead.

## Browser & Web Automation

- **Always prefer `chrome_*` tools (from `pi-chrome`)** over `playwright`, `chrome-devtools-mcp`, or generic `agent_browser` whenever the task involves browsing, scraping, screenshotting, filling forms, or driving a web UI. `chrome_*` uses the user's real signed-in Chrome profile via the companion extension — sessions, cookies, MFA, SSO already there.
- Decision order: (1) `chrome_*` first, (2) `agent_browser`/`playwright`/`chrome-devtools-mcp` only when Chrome is unavailable, the user wants isolation, or explicitly asks.
- Recovery: `chrome_*` returns "Chrome control locked" → ask the user to run `/chrome authorize` (or `/chrome authorize indefinite` for the session) and retry. Extension missing → `/chrome onboard`, then `/chrome doctor`, then `/chrome authorize`.
- Common tools: `chrome_tab`, `chrome_snapshot`, `chrome_navigate`, `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_evaluate`, `chrome_screenshot`, `chrome_list_network_requests`, `chrome_get_network_request`, `chrome_wait_for`, `chrome_upload_file`. Pass `background=true` (or `/chrome background on`) when you don't want Chrome to steal focus.

## Commands

- After code changes (not doc changes): `npm run check` (get full output, no tail). Fix all errors, warnings, and infos before committing. It does NOT run tests.
- NEVER run: `npm run build`, `npm test`, `npm run release:*`.
- Run specific tests only when the user asks: `npx tsx ../../node_modules/vitest/dist/cli.js --run test/specific.test.ts`, from the package root.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` plus the faux provider. Never real provider APIs, real API keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` and name them `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts: write to a temp file with `write`, run it, edit if needed, remove when done. Do not embed multi-line scripts directly in `bash` calls.
- NEVER commit unless the user asks.

## Project tool config

This repo ships `.pi/settings.json` (project-local settings, merged over the
global file). Notable knobs:

- `frequentFiles.enabled: true` — the agent tracks per-file read/edit/write counts and persists the result to `.pi/frequent-files.json` so the next session boots warm.
- `toolDiscovery.enabled: true` — tools outside the coding bundle are hidden behind `search_tool_bm25` to keep the per-turn tool snippet block short.

See `docs/agents/tools-and-config.md` for the full surface and the tool quirks
that live in this repo (vitest paths, strip-only TS, generated files, etc.).

## **CRITICAL** Git Rules for Parallel Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session
- It is always fine to include `packages/ai/src/models.generated.ts` in a commit alongside the actual files you want to commit

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work
- `git commit --no-verify` - bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

### User override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.

## Project docs

Load these only when the active task touches the topic — they are not part of
the per-turn behavior contract.

- `docs/RELEASING.md` — releasing process, CHANGELOG format/attribution, "Adding a New LLM Provider" full recipe.
- `docs/agents/pr-workflow.md` — PR review/merge flow and issue/PR comment hygiene.
- `docs/agents/contribution-gate.md` — auto-gate workflows, `lgtm`/`lgtmi`, `pkg:*` labels.
- `docs/agents/tui-testing.md` — tmux recipe for driving pi's TUI from headless agents.
- `docs/agents/tools-and-config.md` — `.pi/settings.json` shape and project tool quirks.
- `docs/adr/` — architectural decision records (read-guard, diff limit, doom-loop, engineering style).
