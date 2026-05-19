# PiTuned

Personal fork of [pi-mono](https://github.com/earendil-works/pi-mono) tuned for
local interactive use. Focus: faster startup, faster agent loop, better
prompt/tool-call quality. No public API changes — runs as a drop-in replacement
for stock `pi`.

This is a development checkout, not an installable npm package. You run it from
source via `pi-test.sh` / `pi-test.bat`.

## `pi` vs `pit`

Stock pi is invoked as `pi` and untouched. PiTuned is invoked as `pit` and
lives entirely in this repo. They run **side-by-side, isolated**:

| Aspect | `pi` (stock) | `pit` (PiTuned) |
|--------|--------------|-----------------|
| Binary | `npm i -g @earendil-works/pi-coding-agent` | `bin/pit*` in this repo |
| Source | wherever npm put it | `packages/coding-agent/src/` (this repo) |
| Agent dir | `~/.pi/agent/` | `~/.pit/agent/` |
| Settings | `~/.pi/agent/settings.json` | `~/.pit/agent/settings.json` |
| Auth, sessions, packages | `~/.pi/agent/...` | `~/.pit/agent/...` |

The two never share state. Use `pi` for baseline, `pit` for your tuned
version. Compare freely.

Override: set `PI_CODING_AGENT_DIR` before invoking `pit` to point at a
different dir.

### Self-sufficiency

PiTuned does **not** depend on a separately-installed `pi` binary. The
`@earendil-works/*` packages are workspace symlinks inside `node_modules/`
that point at `packages/*` in this repo, so all source code is local. The
stock `pi` binary is optional — if you have it installed, `bootstrap.mjs`
will clone its config into `~/.pit/agent/` on first run so you don't have to
re-login or re-install packages. If you don't have stock pi installed,
`bootstrap.mjs` just starts with an empty `~/.pit/agent/` and you set things
up via `pit login`, `pit install ...`.

## First-time setup

```bash
git clone https://github.com/thiagovelsa/PiTuned.git
cd PiTuned
node scripts/bootstrap.mjs
```

`bootstrap.mjs` is idempotent. It:
1. Runs `npm install` at the repo root if `node_modules/` is missing.
2. **First time only:** clones `~/.pi/agent/` to `~/.pit/agent/` so you keep
   your existing auth, settings, and installed packages. Skips backup files
   and the jiti cache (rebuilt on first run). Pass `--no-clone` to opt out.
3. Installs every pi package listed in `.pi/packages.json` that is missing
   from `~/.pit/agent/npm/node_modules/`.
4. Runs `scripts/precompile-pi-packages.mjs` against the PiTuned agent dir
   so the loader can skip jiti transpilation on every startup.

After setup, add `<repo>/bin` to your PATH so `pit` is callable from
anywhere. Or invoke it directly: `./bin/pit ...`.

### Running

```bash
pit                     # interactive PiTuned
pit --help              # help
pit install npm:foo     # installs into ~/.pit/agent/, not ~/.pi/agent/
pi                      # still works, runs stock pi unchanged
```

The legacy `./pi-test.sh` / `.bat` / `.ps1` scripts still work, but they
use the shared `~/.pi/agent/` dir (no isolation). Prefer `pit` for proper
separation.

## After installing or updating extensions

Whenever you `pit install npm:<something>` or `pit update`, re-run the
precompile step so the new package gets a `.js` sibling next to its `.ts`
source:

```bash
PI_CODING_AGENT_DIR=$HOME/.pit/agent node scripts/precompile-pi-packages.mjs
```

Or just `node scripts/bootstrap.mjs` again — it picks up missing packages
and re-runs the precompile in one shot.

Pass `--force` to recompile everything, or `--clean` to remove the generated
`.js` files (reverts to vanilla TS loading).

## What's tuned vs upstream

### Agent loop (`packages/agent/`)
- Listeners run via `Promise.all` instead of serial `await`. ~5x speedup with
  multiple subscribers (extensions, TUI, session persistence).
- Streaming `*_delta` events are coalesced on a 16ms (60fps) frame budget.
  Listeners that reconstruct text from deltas still see every character —
  the deltas are batched, not dropped. ~53x speedup with a TUI listener on
  long streaming responses.
- Tool map cache: `Map<name, tool>` is built once per batch instead of
  `Array.find` per call.
- `prepareToolCall` + `tool_execution_start` emits run in parallel. ~10x
  speedup when a `beforeToolCall` hook does async work.

### Coding agent (`packages/coding-agent/`)
- Tool selection guidelines + tool batching guidance in the system prompt.
- `edit` tool description includes JSON examples and a common-mistakes list.
- `bash` description lists 6 substitutions to avoid (`cat` → `read`, etc.).
- Default cache retention is `long` (Anthropic 1h, OpenAI 24h). Override
  with `PI_CACHE_RETENTION=short`.

### Startup
- Single shared jiti instance with `moduleCache: true` across all extensions.
  Heavy core libs are transpiled once instead of once-per-extension.
- Native dynamic `import()` fast-path for `.js` extensions with no `.ts`
  sibling. Bypasses jiti entirely.
- Pre-compile script emits `.js` next to shipped `.ts` package sources,
  rewriting `.ts` import specifiers to `.js` and `@mariozechner/pi-*`
  aliases to `@earendil-works/pi-*`. Loader prefers `.js` when its mtime
  is ≥ the `.ts` sibling.

Measured on a Windows 11 box with 17 installed packages:
- Total extension load: **~37s → ~6s** (≈6x).
- Streaming with TUI listener: **~53x**.
- Multi-listener fanout (5 subscribers): **~5x**.

## Benchmarks

```bash
node scripts/precompile-pi-packages.mjs   # one-time, after install
./node_modules/.bin/tsx scripts/bench-tool-calls-real.mts
./node_modules/.bin/tsx scripts/bench-extension-load.mjs
node scripts/bench-persistence.mjs
PI_TIMING=1 ./pi-test.sh --help           # per-extension load timings
```

## Syncing upstream

```bash
git fetch origin
git rebase origin/main      # never force push
git push pituned main
```

`origin` is upstream `earendil-works/pi`; `pituned` is this fork.

## License

Same as upstream pi-mono: MIT.
