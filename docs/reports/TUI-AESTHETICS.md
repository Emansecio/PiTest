# TUI aesthetics — where the Pit falls behind Cursor CLI / Cline / opencode

> Scope: **visual beauty / experience** — composition, framing, color, whitespace
> rhythm, typography, and **streaming fluidity**. Not features, not the agent
> engine (where the Pit leads). Companion to
> [`docs/agents/cli-animations.md`](docs/agents/cli-animations.md) (motion
> mechanics) and [`docs/agents/already-built.md`](docs/agents/already-built.md)
> (inventory). This doc is self-contained on visual experience; cli-animations.md
> is the deep dive on the motion subsystem.
>
> Comparison baseline: opencode (Bubbletea + Lipgloss "Charm aesthetic"), Cline CLI
> (OpenTUI), Cursor CLI. Initial analysis: 2026-06-30.

## Implementation status

| Step | Status | Notes |
|---|---|---|
| **Step 0** — `Card` primitive | **Shipped** | [`packages/tui/src/components/card.ts`](packages/tui/src/components/card.ts), exported from `@pit/tui`, tests in [`packages/tui/test/card.test.ts`](packages/tui/test/card.test.ts). Consumed by welcome card + tool frames. |
| **Move 3** — `tool*Bg` + `cardPaddingX` | **Shipped** | [`dark.json:18-20`](packages/coding-agent/src/modes/interactive/theme/dark.json) bumped; `getCardPaddingX` / `setCardPaddingX` in [`settings-manager.ts`](packages/coding-agent/src/core/settings-manager.ts) (default `1`). Wired in welcome card. |
| **Move 5** — context gauge | **Shipped** | Parallelograms `▰`/`▱` + fluid fill in [`footer.ts`](packages/coding-agent/src/modes/interactive/components/footer.ts); `ui` wired at [`interactive-mode.ts:573`](packages/coding-agent/src/modes/interactive/interactive-mode.ts). Tests updated. |
| **Move 1** — card framing | **Shipped** | **1a:** welcome `Card` ([`welcome-box.ts`](packages/coding-agent/src/modes/interactive/components/welcome-box.ts)), tagline `muted` / version `dim`, `cardPaddingX` wired. **1b:** tool frames via `MessageShell` `frame: true` ([`message-shell.ts`](packages/coding-agent/src/modes/interactive/components/message-shell.ts), [`tool-execution.ts:103`](packages/coding-agent/src/modes/interactive/components/tool-execution.ts)). **1c:** editor border `borderMuted → border` ([`theme.ts:1233`](packages/coding-agent/src/modes/interactive/theme/theme.ts)); `cardBg` runtime token ([`dark.json:90`](packages/coding-agent/src/modes/interactive/theme/dark.json)); skills-doctor off quiet startup. **Deferred:** placeholder into editor (no `@pit/tui` placeholder API); rounded editor frame. |
| **Move 2** — truecolor gradient | **Shipped** | [`wordmarkGradient`](packages/coding-agent/src/modes/interactive/theme/color-interpolation.ts) + [`h1Gradient`](packages/coding-agent/src/modes/interactive/theme/color-interpolation.ts) (3-stop stitch via `mdHeading → borderAccent → border`); H1 hook [`MarkdownTheme.heading1`](packages/tui/src/components/markdown.ts). 256-color bicolor (`accent` / `thinkingXhigh`). Static — no ticker sweep. |
| **Move 4** — footer empty-state | **Shipped** | [`footer.ts`](packages/coding-agent/src/modes/interactive/components/footer.ts) `collapseLine2`: pristine idle session → 1 line (identity + permission mode as `protectedSuffix2` after the ✦ chip); accrued usage + abnormal states (`no-rails`, `no-compact`, `overthink`, `recovery`) keep 2+ lines. `composeLeftRight` gained `protectedSuffix2`. `pristine` keys on `hasUserTurn()` (no user message yet), not `usedTokens === 0` — the token-zero check was unreachable in real sessions because the system prompt loads ~18k wire tokens before the first turn. Tests in [`footer.test.ts`](packages/coding-agent/test/footer.test.ts). |

**Batch 1 gate (Step 0 + Move 3 + Move 5):** `npm run check` green (2026-06-30).

**Batch 2 gate (Move 1 + Move 2):** `npm run check` green (2026-06-30); targeted tests green (`welcome-box.test.ts`, `message-shell.test.ts`, `interactive-mode-status.test.ts`, `spinner-cadence.test.ts`). **Visual verification at 60/140 cols passed** (2026-06-30): card frame closes, wordmark + H1 gradient render teal→lavender, editor border lifted, no width crash.

**Batch 3 gate (Move 4):** `npm run check` green (2026-06-30); `footer.test.ts` 20/20 + related footer tests 23/23. Visual gate caught a real defect the unit tests missed: the first `pristine` implementation keyed on `usedTokens === 0`, which is unreachable once the system prompt loads ~18k wire tokens — the footer never collapsed in a real session. Fixed by keying `pristine` on `hasUserTurn()` (no user message in `session.messages` yet); tests updated to simulate `messages` with `role: "user"` for active sessions. Post-fix visual re-verification pending a re-run.

## Contents

1. [Implementation status](#implementation-status)
2. [Current aesthetic identity](#the-pits-current-aesthetic-identity)
3. [Streaming & fluidity (already strong)](#streaming--fluidity-already-strong)
4. [Where the Pit falls behind aesthetically](#where-the-pit-falls-behind-aesthetically)
5. [Initial screen — line-by-line](#initial-screen--line-by-line-against-the-live-screenshot)
6. [Real gap vs deliberate trade-off](#real-gap-vs-deliberate-trade-off)
7. [Truecolor vs 256-color aesthetic split](#truecolor-vs-256-color-aesthetic-split)
8. [Ship order](#ship-order) — Step 0 + Moves 1–5, sequenced by risk
9. [Highest-ROI aesthetic moves](#highest-roi-aesthetic-moves-with-filesconstants-to-touch) — Step 0 + Moves 1–5
10. [No new dependencies — own the render path](#no-new-dependencies--own-the-render-path)
11. [Non-goals](#non-goals-do-not-bundle-with-these-moves)
12. [Grilling log](#grilling-log--load-bearing-claims-verified)
13. [Verification](#verification-per-agentsmd)

## The Pit's current aesthetic identity

Read in code, the Pit has a **coherent** visual language — flat, dense, "pretty
terminal log", earthy teal. The pieces:

- **Palette** (`packages/coding-agent/src/modes/interactive/theme/dark.json`):
  teal `#8ad8c4` / coral `#e08a72` / gold `#e0c07b` / lavender / cyanBlue over
  `#0c1110`. 9 syntax colors, 6 thinking-border colors, 7 gutter colors. Designer
  palette, not generic cyan/magenta. **A strength.**
- **Chat-block idiom** — **dual mode** (Move 1b shipped):
  - Default: 1-column `│` gutter + bold bracketed label (`message-shell.ts`,
    `SHELL_GUTTER_COLS = 2`).
  - Tool blocks: rounded card frame `╭─╮│╰─╯` via `MessageShell` `frame: true`
    (`SHELL_FRAME_COLS = 4`; children at `width - 4`). Running spinner replaces
    the top-left corner cell.
- **Welcome block** (`welcome-box.ts`) — **rounded card** (Move 1a shipped):
  `Card` from `@pit/tui` wraps the 3-row half-block wordmark `█▀█ █ ▀█▀` on
  `cardBg` with `cardPaddingX` from settings. Tagline `muted`, version `dim`.
  Wordmark uses a column gradient (`wordmarkGradient`, Move 2).
- **Borders** (`dynamic-border.ts:36`): horizontal `─` rules remain for bash /
  compaction; tool blocks and welcome now use rounded frames where opted in.
- **Footer** (`footer.ts:294-485`): 2 dense lines — `CTX ▰▰▱▱▱▱ 23% · 47k/200k  •
  ↑12k ↓3k  •  plan  •  fusion: …  •  overthink ×2`. Parallelogram context gauge
  with fluid fill (Move 5); color-escalating percent, protected thinking chip.
- **Diff** (`diff.ts:12-16`): word-level intra-line, **bold token in the line's
  diff color, no reverse-video**, background preserved.
- **Motion**: phase-locked braille spinner + truecolor breathing + settle
  crossfades — the most polished subsystem in the Pit.

Coherent ≠ visually rich by 2026 standards. The gaps below are about **framing
courage**: the Pit has the engine and the palette, but avoids boxes, gradients,
and padding. Before the gaps, the side that is **already strong** — streaming
and fluidity — because it is the Pit's aesthetic high ground.

## Streaming & fluidity (already strong)

The Pit's motion/streaming subsystem is its **most polished** area — none of
Cursor CLI / Cline / opencode ships all of this. The deep mechanical reference
is [`docs/agents/cli-animations.md`](docs/agents/cli-animations.md); this
section covers the **experience** angle and the few aesthetic nits the
mechanics doc does not weigh.

### What already works beautifully
- **Reveal smoothing** (`assistant-message.ts:26-35, 688`): the provider burst
  is **not painted whole** — a reveal cursor advances at a steady rate off the
  shared ticker. `REVEAL_CATCHUP_FRAMES=8` (~130ms to absorb a burst at 60fps),
  `REVEAL_MIN_STEP=1`, `REVEAL_MAX_STEP=48` (caps a big burst to ease in
  instead of snapping). Streaming reads as a steady materialization, not a
  stutter.
- **Fade wavefront** (`fadeLineTail:126`, `REVEAL_FADE_COLUMNS=6`): freshly
  revealed text materializes through a dim→bright gradient at the wavefront,
  grapheme-aware (never splits an emoji / ZWJ sequence). Soft, not pop.
- **Thinking breath** (`assistant-message.ts:23-24`): `Thinking…` breathes
  dim⇄normal on a 1800ms / 8-bucket cycle while the model is mid-thought.
- **Settle crossfades** (`color-ease.ts`, `activity-line.ts`, `nav-group.ts`):
  spinner→✓/✗ holds the last spinner glyph through the first half of a 180ms
  `ColorEase` — the state change reads as a transition, not a swap.
- **Phase-locked spinners** (P7) + **truecolor breathing** working-loader.
- **Markdown streaming is cheap** (`assistant-message.ts:62-72`):
  `Markdown.setText()` invalidates only the flat cache, preserving
  `tokenLineCache` — appending a chunk re-renders only the trailing token,
  not the whole buffer (was O(n²) per message before). Keeps long streamed
  answers smooth.
- **CSI 2026 synchronized output** wraps every frame → low flicker.

### Aesthetic nits on streaming (not in cli-animations.md — that doc is
mechanics, not reading beauty)
- **`DEFAULT_ASSISTANT_READING_COLUMNS = 0`** (`assistant-message.ts:51`) —
  assistant prose runs **edge-to-edge** on a wide terminal. Smooth streaming
  does not help if a line is 180 cols and the eye loses the margin. A reading
  measure (~80–100 cols) reads better during the stream. Already overridable
  via the `assistantReadingColumns` setting; the default is 0.
- **`REVEAL_FADE_COLUMNS = 6`** — tuned for truecolor at normal font size; on
  small fonts 6 cols can read as "pop" rather than "materialize". Tunable;
  cli-animations.md lists it under feel-tuning but not as a beauty decision.
- **256-color degradation** — `fadeLineTail` uses `interpolateFg`, which
  returns `undefined` without truecolor (`color-interpolation.ts:52`) → the
  fade collapses to flat dim → streaming loses its "soft" on basic terminals
  (SSH defaults, older Windows conhost). See
  [Truecolor vs 256-color](#truecolor-vs-256-color-aesthetic-split) below.
- **No "still alive" micro-indicator** beyond the spinner. opencode shows a
  token-rate / streaming-progress hint. The Pit's spinner is prettier, but on
  a long stream there is no sense of *how fast* text is arriving.

### Streaming verdict
Fluidity is **the** part of the Pit's visual experience that already beats the
competitors. The work here is **feel-tuning and 256-color parity**, not new
mechanisms — and explicitly **not** re-tuning cadence constants without the
measurement pass called out in Non-goals.

## Where the Pit falls behind aesthetically

### 1. No box / card framing — **partially closed (Move 1 shipped)**
Welcome and tool blocks now use rounded `╭─╮│╰─╯` frames with internal
padding. The editor border color was lifted (`borderMuted → border`) but the
editor is still a single-line rectangle — a full rounded editor frame is
**deferred** (lives in `@pit/tui` `editor.ts`, higher layout risk). Assistant /
bash / diagnostics blocks still use the gutter idiom unless they opt into
`frame: true`.

### 2. No multi-pane / sidebar composition
Pit = one vertical column (chat → footer → editor). opencode composes a
**session sidebar + main pane + status bar** — it reads as *app*, Pit reads as
*log*. Even without a tree sidebar, a fixed header (name + model) and a more
spacious footer would shift the perception.

### 3. No truecolor gradient text — **closed on wordmark + H1 (Move 2 shipped)**
The wordmark and H1 headings now use column gradients via `wordmarkGradient` /
`h1Gradient` (`color-interpolation.ts`), with a deliberate bicolor fallback on
256-color terminals. Static this batch — no ticker-driven sweep yet. H2+ still
use flat `mdHeading`.

### 4. No whitespace / padding rhythm — **partially closed**
Top-to-bottom density: the footer compresses identity + metrics + extension
statuses into 2–3 lines (`footer.ts:453-480`); chat blocks are separated by a
single blank (`message-shell.ts`); welcome and tool blocks now have 1-col
internal padding via `Card` / `SHELL_FRAME_COLS`. The editor border is now
`border` (`getEditorTheme()` in `theme.ts:1233`, Move 1c) — brighter than the
old `borderMuted #2a3633`, but still a single-line frame, not a padded card.
opencode/Cline still use more generous padding inside the input card — a
deliberate density trade-off unless the rounded editor frame ships.

### 5. The input editor is visually recessive — **partially closed (Move 1c)**
Editor border color is now `border` (cyan-blue, `#4fb6c4` in dark) instead of
`borderMuted`. Still a single-line frame — no rounded card, no internal
placeholder (the `Describe a task…` hint remains a separate `Text` in the chat
container; moving it into the editor is **deferred** pending a `@pit/tui`
editor placeholder API).

### 6. Tool-block backgrounds are nearly invisible — **partially closed**
`toolPendingBg #1e2926`, `toolSuccessBg #1c2a20`, `toolErrorBg #33221e`
(`dark.json:18-20`, Move 3 shipped) are one tone up but still subtle against the
page. Tool blocks now also carry a rounded frame (Move 1b) so they read as
cards, not just tinted log lines. opencode/Cline backgrounds may still read
louder — further `tool*Bg` tuning is a trade-off, not a framing gap.

### 7. Diff is unified-only, inline in chat
The intra-line bold-token emphasis is tasteful (`diff.ts:12-16`, no
reverse-video) — but it is unified-only and embedded in the chat flow.
opencode's **side-by-side with syntax highlighting in both panes** reads as
"real IDE". Higher effort, but a different aesthetic tier.

### 8. Footer: wins on info, loses on calm
One footer line can carry `CTX ▰▰▱▱▱▱ 23% · 47k/200k • ↑12k ↓3k • plan • fusion:
… • overthink ×2`. opencode's status bar is **more spaced, fewer segments**.
The Pit wins on state honesty, loses on "less is more". Modern taste reads
calmer.

## Initial screen — line-by-line (post Move 1 + Move 2)

The first-launch screen is the Pit's face. After Move 1 + Move 2 it reads as a
**framed welcome card + hint line + accent-bordered editor + 2-line footer**.
Anchored in code:

### Header — centered hero (fresh sessions)
Rendered by `WelcomeBox` → `computeHeroRows`
([`welcome-box.ts`](packages/coding-agent/src/modes/interactive/components/welcome-box.ts)):

```
                    ██████  ████  ██████
                    ██  ██   ██     ██
                    ██████   ██     ██
                    ██       ██     ██
                    ██      ████    ██

               Coding agent in your terminal · v0.75.4
```

- Fresh sessions on the default app name render a **borderless centered hero**:
  a 6-row ANSI-shadow wordmark in the brand **neon-green → lime diagonal
  gradient** (`pitLogoGradient`, `color-interpolation.ts`). Truecolor only;
  256-color terminals get flat theme `success` green, light themes a deeper
  green pair for contrast. On mount the wordmark **ignites**: a one-shot ~500ms
  smoothstep ease from `dim` up to a bright brand mid-tone, then hands off to
  the full gradient (`startHeroIgnition`, skipped under reduced motion /
  no-truecolor / resume).
- Tagline stays **`muted`** with the version as a **`dim`** suffix on the same
  centered line. The workspace bullet was **removed from the hero** (2026-07
  declutter pass): the footer identity line shows cwd/branch/shell-note on the
  same fresh-session screen, so the hero copy was a straight duplicate. The
  compact card keeps its workspace line.
- Resumed sessions, custom app names and viewports **under 40 cols** fall back
  to the compact framed card (3-row teal → lavender wordmark via
  `wordmarkGradient`, `cardBg` + `cardPaddingX` intact) — resume line and all.

### Hint block — gone on the default brand
`updateEmptyStateHint` (`interactive-mode.ts`) paints **no hint at all** under
the hero since the 2026-07 declutter pass — just a Spacer for rhythm. Both old
lines were removed:

- The `Try "explain this codebase" · …` examples line read as clutter under the
  hero; the `Describe a task…` invitation lives in the editor placeholder.
- The **mechanics line** (`/ commands · ! bash · drop files to attach`)
  duplicated the startup essentials hint (`/ commands · ! bash · ⌃O more`) and
  the expanded shortcut list, and "drop files" survives in the rotating tips.

A rebranded app (no hero) keeps its compact left-aligned mechanics line.
**`2 dup — /skills doctor` no longer paints on quiet startup** (Move 1a). The
hint is available via `/skills doctor`; it is not part of the welcome paint.

### Editor — accent border, still single-line frame
The editor border is now **`border`** (`theme.ts:1235`, cyan-blue) instead of
`borderMuted`. Reads brighter on the initial screen but remains a single-line
rectangle — a full rounded editor card is **deferred**.

### Footer — one calm line on first launch (Move 4 shipped)
On a pristine idle session the footer now renders **one line**: identity
(cwd + model + ✦ chip) with the permission mode (`auto`/`plan`) appended as a
protected dim suffix after the chip. The old sparse metrics row (`CTX 200k`
left, lone `auto` right) is gone. As soon as usage accrues, the full 2-line
footer returns (`CTX ▰▰▱▱ 23% · 47k/200k` left, `↑in ↓out • …` right). Abnormal
states (`no-rails`, `no-compact`, `overthink ×N`, `recovery`) keep 2+ lines and
their alerts.

### Initial-screen verdict (updated)
The first screen is **materially more product-like** than before the moves:
centered neon-green hero wordmark (with mount ignition), fixed tagline/version
hierarchy, no maintenance noise on quiet startup, brighter editor border, and a
calm one-line footer.

### Polish round (2026-07, docs/tui-polish-study.md)
- **Accent is `mint #86e6b2`** (was teal) — the "bridge" palette: UI rhymes with
  the lime brand without hijacking success/diff semantics; `dim` and
  `syntaxComment` raised to legible contrast (~3.6:1 / ~4.4:1).
- **One heartbeat**: `HEARTBEAT_CYCLE_MS = 1800` (@pit/tui) drives the spinner
  pulse AND the thinking-label breath in lockstep; the pulse kisses brand lime
  at its peak (`working-palette.ts`).
- **Label shimmer**: the working-loader phase label ("Thinking…") gets a soft
  brightness band sweeping once per heartbeat (`shimmerColorAt` +
  `Loader.setMessageColorAt`); flat muted under no-truecolor/reduced-motion.
- **Working line** carries a live `↑ n tok` output-token chip beside the
  interrupt hint and ↓rate.
- **Turn rules**: a hairline `─` rule (borderMuted) precedes each user prompt
  after the first (`turn-rule.ts`), in both live and rebuilt transcripts.
- **mcp.notice is a quiet aside**: one muted `◦` line, aggregated across skipped
  servers, instead of the default custom-message card. Remaining gaps: editor still not a padded card, placeholder still
floats above the editor.

## Real gap vs deliberate trade-off

| Item | Verdict | Addressed by |
|---|---|---|
| Rounded boxes / cards | **Partially closed** — welcome + tool blocks framed; editor still single-line | Step 0 + Move 1 (**shipped**); rounded editor **deferred** |
| Multi-pane / sidebar | **Real gap** (high cost) | not in scope (Non-goal) |
| Truecolor gradient on wordmark + H1 | **Closed** (wordmark + H1; static) | Move 2 (**shipped**) |
| Padding / whitespace rhythm | **Trade-off** (density is identity), improved in cards | Move 1 (**shipped**), Move 3 (**shipped**) |
| Editor as prominent card | **Partially closed** — border lifted, no rounded frame / placeholder | Move 1c border **shipped**; card + placeholder **deferred** |
| More visible tool-block bgs | **Trade-off** — one tone up + frame | Move 3 + Move 1b (**shipped**) |
| Side-by-side diff | **Real gap** (medium-high effort) | not in scope (separate `SplitDiff` effort) |
| Less dense footer | **Partially closed** — idle session collapses to 1 line | Move 4 (**shipped**) |
| Chunky context gauge | **Trade-off** — full-block bar reads heavy | Move 5 (**shipped**) |

## Truecolor vs 256-color aesthetic split

A cross-cutting note that affects the palette, Move 2 (gradient), and the
streaming fade wavefront alike: **the Pit is materially more beautiful in
truecolor**, and degrades gracefully but visibly on basic terminals.

- Every animated-color path gates on `getCapabilities().trueColor` and snaps to a
  discrete theme color when it is false. The `fadeLineTail` streaming wavefront
  goes through `interpolateFg`, which returns `undefined` when
  `!getCapabilities().trueColor` (`color-interpolation.ts:52`); the working-loader
  truecolor breathing (`working-palette.ts`) builds its gradient directly from
  `lerpRgb` / `rgbFg` with its own `trueColor` gate
  (`working-palette.ts:66`). Callers snap to a discrete theme color, so on
  256-color the gradient → flat accent, the streaming fade → flat dim, the
  breathing pulse → 256-color discrete steps (already handled in
  `working-palette.ts`).
- Who is affected: SSH with default `TERM=xterm`, older Windows conhost, any
  terminal without `COLORTERM=truecolor` / `setrgbf` capability detection.
  These users see a **flatter** Pit — still functional, not the showcase.
- Implication for Move 2: **shipped** with a deliberate 256-color fallback —
  `bicolorColumnColor` alternates `accent` (odd cols) / `thinkingXhigh` (even
  cols) in `color-interpolation.ts:31-36`, not a flat `accent` snap.
- `detectTerminalBackground` (`theme.ts:739`) already inspects `COLORFGBG` /
  OSC 11 for light/dark; capability detection (`getCapabilities().trueColor`)
  is the parallel signal. A one-time debug-log when `trueColor === false`
  (gated behind an existing debug flag) would set expectations without nagging.

## Ship order

The moves are **not parallel** — they have different blast radius and a real
dependency. Ship in this order, one PR per step, evaluate before the next:

1. ~~**Step 0 — `Card` primitive**~~ **Shipped.** [`card.ts`](packages/tui/src/components/card.ts)
   + [`card.test.ts`](packages/tui/test/card.test.ts). Consumed by welcome card
   + tool-block frames.
2. ~~**Move 3 — theme tokens**~~ **Shipped.** `tool*Bg` one-tone-up +
   `cardPaddingX` setting; wired in welcome card.
3. ~~**Move 1 — card framing**~~ **Shipped** (1a welcome → 1b tool frames → 1c
   editor border + tokens). Placeholder + rounded editor frame **deferred**.
4. ~~**Move 2 — truecolor gradient**~~ **Shipped.** Wordmark + H1 gradients;
   256-color bicolor fallback. Static (no ticker sweep this batch).
5. ~~**Move 4 — footer empty-state**~~ **Shipped.** Idle pristine session → 1
   line (permission mode folded onto identity as a protected suffix); accrued
   usage + abnormal states keep 2+ lines. `composeLeftRight` `protectedSuffix2`.
6. ~~**Move 5 — refined context gauge**~~ **Shipped.** Parallelogram glyphs +
   fluid fill (`footer.ts:72-94`, cache gate while `fillEaseActive`).

**Never bundle** Step 0 with Move 1, nor Move 1 with Move 2 — different failure
modes (layout math vs color snap vs ticker path). See Non-goals.

## Highest-ROI aesthetic moves, with files/constants to touch

Each move carries **Risk** (blast radius) and **Done when** (acceptance) so a
reviewer can green-line it without re-reading the rest of the doc.

### Step 0 — `Card` / `Box` primitive in `@pit/tui` — **shipped**

**Status:** implemented in [`packages/tui/src/components/card.ts`](packages/tui/src/components/card.ts),
exported from `@pit/tui`, tested at [`packages/tui/test/card.test.ts`](packages/tui/test/card.test.ts).
Welcome card + tool-block frames consume it.

**Create** a new `Card` primitive (`packages/tui/src/components/card.ts`). Do **not**
"extend `box.ts`" — `Box` (`packages/tui/src/components/box.ts`) is a padding +
background container (`paddingX` / `paddingY` / `bgFn`); it has no border concept
and no `╭─╮` glyph rendering, so there is nothing to extend. `Card` composes
`Box` for the inner padding/bg and adds the rounded border on top. The memo
pattern to copy is `DynamicBorder` (`dynamic-border.ts:11-38`) — a width-keyed
memoized `─` rule generalized to top `╭─…─╮` / bottom `╰─…─╯` + side `│` gutters,
with the same `invalidate()`-on-theme-change cascade. Same package, same paradigm
as `SelectList`. **Not** an npm dependency — see
[No new dependencies](#no-new-dependencies--own-the-render-path).

- **Risk:** low — additive primitive, no existing call site forced to change.
- **Done when:** the primitive renders a 1-col-padded rounded box at widths 60
  and 140 without "Rendered line exceeds terminal width"; one existing
  `DynamicBorder` site converted as a smoke test; `npm run check` green.
- **Files:** `packages/tui/src/components/card.ts` (new), composing
  `packages/tui/src/components/box.ts` (padding/bg) and the memo pattern from
  `packages/coding-agent/src/modes/interactive/components/dynamic-border.ts:11-38`.

### Move 1 — Cards with rounded corners + padding — **shipped**

**Status (2026-06-30):** implemented in three sub-steps. Width-invariant tests
green at widths 12–120 (`welcome-box.test.ts`, `message-shell.test.ts`).

| Sub-step | Shipped | Deferred |
|---|---|---|
| **1a** welcome card | `Card` wrapper, `cardPaddingX`, tagline/version hierarchy, skills-doctor off quiet startup | — |
| **1b** tool frames | `MessageShell.frame: true`, spinner in top-left corner, `ToolExecutionComponent` opts in; `renderShell:"self"` stays unframed | Reusing `Card` primitive inside `MessageShell` (frame math inlined instead) |
| **1c** editor + tokens | `getEditorTheme().borderColor`: `borderMuted → border`; `cardBg` runtime `ThemeBg` | Rounded editor frame; placeholder into editor |

Turn welcome, tool blocks, and the editor into framed cards using
`╭─╮│╰─╯` glyphs with 1-col internal padding. Safe under
`visibleWidth()` / `truncateToWidth()`. **Depends on Step 0** — uses the
`Card` / `Box` primitive; do not hand-roll framing per call site.

- **Risk:** high — layout math is the width-crash surface (the ADR-0002 concern).
  Mandatory narrow-width visual verification.
- **Done when (acceptance):** welcome + tool blocks render as rounded cards at
  widths 60 and 140 with no "Rendered line exceeds terminal width"; skills-doctor
  no longer paints on quiet startup; `npm run check` green. **Met** except
  60/140-col tmux visual (still owed). Placeholder + rounded editor **not in
  scope** for this batch.

**As implemented:**
- Welcome: `Card` + `composeLeftRight`; border `borderMuted`; bg `cardBg`.
- Tools: `MessageShell.frame` + `SHELL_FRAME_COLS`; spinner in top-left corner.
- Editor: `borderColor` only (`theme.ts:1235`); rounded frame **deferred**.
- Skills-doctor: removed from `showLoadedResources` quiet path; use `/skills doctor`.
- Tokens: `cardBg` in `ThemeBg` + `dark.json`/`light.json` `colors`; `cardBorder`
  alias in theme JSON (frames use `borderMuted` at call sites).

**Deferred follow-ups:**
- Placeholder into `@pit/tui` editor (needs API).
- Rounded editor frame (`packages/tui/src/components/editor.ts`).

### Move 2 — Truecolor gradient on wordmark + H1 headings — **shipped**

**Status (2026-06-30):** static column gradients; `spinner-cadence.test.ts` green
(no ticker path touched).

Animate the wordmark and color H1 markdown headings with a left-to-right hue
gradient. Infra already present. **Layers on top of Move 1** (the framed
wordmark / H1 must exist first).

- **Risk:** medium — touches the truecolor/256-color snap contract.
- **Done when:** the wordmark and H1 render a left-to-right hue gradient in
  truecolor and a **deliberate** discrete bicolor fallback in 256-color (not a
  flat `accent` snap); `spinner-cadence.test.ts` green. **Met.**

- `wordmarkGradient` (`color-interpolation.ts:39-47`) — default wordmark color
  in `welcome-box.ts:162`. Truecolor: `accent → thinkingXhigh`; 256-color:
  `bicolorColumnColor`.
- `h1Gradient` (`color-interpolation.ts:51-64`) — 3-stop stitch:
  `mdHeading → borderAccent` (first half), `borderAccent → border` (second
  half). Exposed via `getMarkdownTheme().heading1` (`theme.ts:1186`) and
  optional `MarkdownTheme.heading1` in `@pit/tui` `markdown.ts`.
- **Not shipped:** ticker-driven horizontal sweep (`ui.addAnimationCallback`).
  H2+ still flat `mdHeading`.

### Move 3 — Visible tool-block cards + `cardPaddingX` setting — **shipped**

**Status:** `tool*Bg` vars bumped in [`dark.json:18-20`](packages/coding-agent/src/modes/interactive/theme/dark.json);
`getCardPaddingX` / `setCardPaddingX` in [`settings-manager.ts`](packages/coding-agent/src/core/settings-manager.ts)
(default `1`). **Wired** in welcome card via `buildWelcomeBoxData`
(`interactive-mode.ts:1368`).

One-tone-up the tool backgrounds and add a tunable card-padding setting. **Does
not touch the editor border** — that is owned by Move 1.

- **Risk:** low — color tokens + one settings key, no layout math.
- **Done when:** the three `tool*Bg` vars read as cards (one tone up, hue
  preserved); `cardPaddingX` defaults to 1 and is overridable; `npm run check`
  green.

- `packages/coding-agent/src/modes/interactive/theme/dark.json:18-20` — raise
  the three `tool*Bg` vars by ~1 tone (e.g. `toolPendingBg #18211f → #1e2926`,
  `toolSuccessBg #16241c → #1c2a20`, `toolErrorBg #2a1d1a → #33221e`). Keep the
  hue, lift the value.
- Optional: add `cardPaddingX` to `settings-manager.ts` (mirrors
  `getEditorPaddingX()`) so card padding is user-tunable, default 1.

### Move 4 — Footer empty-state balance (micro) — **shipped**

**Status (2026-06-30):** implemented in [`footer.ts`](packages/coding-agent/src/modes/interactive/components/footer.ts).
`npm run check` green; `footer.test.ts` 20/20. `pristine` keys on `hasUserTurn()`
(not `usedTokens === 0`) after the visual gate caught the token-zero proxy being
unreachable in real sessions (system prompt loads ~18k wire tokens before the
first turn).

On first launch the footer's second line was **sparse**: `CTX <capacity>` (left,
dim) and `auto` (right, dim) sat alone on the metrics row — two dim tokens where
a busy session would carry `↑in ↓out • overthink ×N`. Now a pristine idle
session collapses to **one line**.

- **Risk:** medium — touches footer layout logic and the `pristine` guard; wrong
  guard = a busy session loses its metrics line.
- **Done when:** a truly fresh session shows one footer line; a session with
  accrued usage still shows both lines with `↑in ↓out • overthink ×N` intact;
  `npm run check` green. **Met.**

**As implemented:**
- `composeLeftRight` gained `protectedSuffix2?: { text; width }` — a second
  never-truncated suffix glued after `styledRight`; `suffixWidth` is the sum of
  both. Used to place the permission-mode bit after the ✦ thinking chip.
- `collapseLine2 = pristine && !modeIsAbnormal && !fusionSegment && !goalStatus
  && otherStatuses.length === 0 && mode !== null && mode !== "no-rails"`.
- `modeIsAbnormal = mode === "no-rails" || !autoCompactEnabled ||
  overthinkGuardCount > 0 || recoverySegment !== null`.
- `pristine = !hasUserTurn() && contextWindow > 0` — `hasUserTurn()` checks
  `session.messages` for any `role: "user"` entry. The system prompt + tool
  schema live in `agent.state.systemPrompt` / tools, NOT in `messages`, so
  `messages` is genuinely empty on a fresh launch even though
  `getContextUsage()` already reports ~18k wire tokens. Keying on
  `usedTokens === 0` (the first attempt) made the collapse unreachable in real
  sessions — caught by the visual gate, not by unit tests (synthetic fixtures
  set `tokens === 0` directly). The cache key includes `hasUserTurn()` so the
  first user turn re-renders the footer into its 2-line form.
- When `collapseLine2`: skip the metrics line; append the mode bit
  (` • ${mode}`, dim) to the identity line as `protectedSuffix2`. Extension
  statuses (line 3) still render if present.
- `no-rails` keeps its dedicated bold-red alert line (excluded from collapse).

### Move 5 — Refined context gauge (parallelograms + fluid fill) — **shipped**

**Status:** implemented in [`footer.ts:72-94`](packages/coding-agent/src/modes/interactive/components/footer.ts)
(`CTX_GAUGE_FILLED` / `CTX_GAUGE_EMPTY`, `renderFooterContextBar(displayedFill, …)`),
fluid fill via ticker + `fillEaseActive` cache gate; `ui` wired at
[`interactive-mode.ts:573`](packages/coding-agent/src/modes/interactive/interactive-mode.ts).
Tests: [`footer.test.ts`](packages/coding-agent/test/footer.test.ts),
[`footer-stats-cache.test.ts`](packages/coding-agent/test/footer-stats-cache.test.ts).

The context bar **was** a chunky full-block gauge (`CTX ███░░░ 23%`). `█` (U+2588)
filled the entire cell height and `░` (U+2591) added noisy shade — it read as a
"metal bar". Now **slanted parallelograms** `▰`/`▱` with eased fill.

- **Risk:** low-medium — single render function; touches the shared ticker path
  and the footer render cache, but the cache fix is a `cacheable`-style gate
  (mirror `activity-line.ts`), not a refactor.
- **Done when:** the bar renders `▰▰▰▱▱▱`-style; the fill eases over ~150–200ms
  when the percent changes (wavefront materializes, no pop); the **percent text
  stays instant** (it is the exact datum — only the bar eases); no frame-cost
  spike on a streamed answer; `npm run check` + `test/footer.test.ts` green.

- `packages/coding-agent/src/modes/interactive/components/footer.ts:72-94`
  (`renderFooterContextBar`, `CTX_GAUGE_FILLED` / `CTX_GAUGE_EMPTY`) — **done.**
  Glyphs `▰`/`▱`; width stays `FOOTER_CTX_BAR_WIDTH = 6`. Empty cells use
  `theme.fg("dim", "▱".repeat(empty))`.
- **Fluid fill** — **done.** `displayedFill` eases via `addAnimationCallback`
  ticker (smoothstep over `COLOR_EASE_MS`); leading fractional cell via
  `interpolateFg("dim", "accent", frac)`; cache skipped while `fillEaseActive`.
  Percent text stays instant.
- **Cache interaction** — **done.** `render()` skips `renderCacheLines` hit
  while `fillEaseActive()` (mirror `activity-line.ts` `cacheable` gate).
- **256-color / no-truecolor** — parallelograms are glyphs, not
  color-interpolated, so they render in the same discrete theme color
  `getContextUsageColor` already picks (`theme.ts:434-443`); only the leading
  fractional cell's `interpolateFg` snap needs the existing undefined-snap
  fallback. No new 256-color path beyond matching `fadeLineTail`'s contract.
- **Font fallback** — `▰`/`▱` require a monospace font with U+25B0/U+25B1
  (Cascadia Code, JetBrains Mono, Fira Code, Iosevka ship them). On a font
  without them they render as tofu. Mitigation: keep the filled/empty glyph as
  two single tunable constants in `footer.ts` so a fallback to dots (`●`/`○`,
  universally safe) is a one-line change.
- **Tests** — `test/footer.test.ts` and `footer-stats-cache.test.ts` assert
  `▰`/`▱`. `theme-context-usage-color.test.ts` tests color only — unchanged.

## No new dependencies — own the render path

All moves above are **zero new deps**. The Pit's render engine *is* the asset
that makes the aesthetic work cheap and safe; pulling a TUI framework would
discard it.

- **`@pit/tui` already ships** differential render + CSI 2026 sync +
  `addAnimationCallback` ticker + `visibleWidth()` / `truncateToWidth()` (the
  invariant that makes box framing safe) + `SelectList` / `Box` / `Container` /
  `Spacer` (composition primitives). The gradient helpers `interpolateFg` /
  `lerpRgb` / `rgbFg` live in `@pit/coding-agent`
  (`modes/interactive/theme/color-interpolation.ts`), not `@pit/tui`.
  `@pit/coding-agent` already depends on `chalk`, `diff` (jsdiff, used in
  `diff.ts:1`), `highlight.js`; `marked` is a `@pit/tui` dependency (the
  markdown renderer lives there).
- **The only "library-shaped" gap is internal** — `Card` (**shipped** in
  [`packages/tui/src/components/card.ts`](packages/tui/src/components/card.ts))
  composes `Box` for padding/bg and generalizes `DynamicBorder`
  (`dynamic-border.ts:11-38`): top/bottom `╭─…─╮` / `╰─…─╯` + side `│` gutters +
  optional `cardBg` padding, keyed by width with the same memo pattern. **Call
  sites:** welcome card (`welcome-box.ts`), tool-block frames (`message-shell.ts`
  `frame: true` — inline frame math, not `Card` subclass).
- **Side-by-side diff** (gap #7) is also zero-dep: `diff` (jsdiff) already
  provides `diffLines` / `diffWords`; side-by-side is a **layout** problem
  (two columns via `truncateToWidth`, hunk-aligned), not an algorithm
  problem. A `SplitDiff` component in
  `packages/coding-agent/src/modes/interactive/components/` resolves it.

### Do not adopt
- **Ink (Vercel)** — React-for-CLI with flexbox/hooks. Adopting it means
  rewriting `@pit/tui` and discarding the diff fast-path, CSI 2026 sync,
  phase-locked ticker, memoized caches, and the `dispose()` leak discipline.
  Incompatible with the `visibleWidth`-based TUI invariants in AGENTS.md,
  which are the Pit's own discipline. **No.**
- **boxen (sindresorhus)** — draws a box around a single string, one-shot.
  Fine for a CLI banner, wrong for a live render-loop component. Use only as
  a **reference** for rounded-box glyph math, not as a dep.
- **gradient-string** — static gradient convenience. The Pit needs
  per-grapheme column coloring tied to the animation ticker; a static lib
  does not help. `lerpRgb` + `rgbFg` already cover it.
- **string-width / slice-ansi / wrap-ansi** — duplicate `visibleWidth` /
  `truncateToWidth`, which the Pit maintains aligned to its own invariants.
  **No.**

## Non-goals (do not bundle with these moves)

- Do **not** change `SPINNER_FRAME_MS`, `REVEAL_CATCHUP_FRAMES`,
  `REVEAL_FADE_COLUMNS`, or any cadence/feel constant in `cli-animations.md` —
  motion/streaming is the polished subsystem; feel-tuning needs its own
  measurement pass (see the Streaming section's nits).
- Do **not** adopt a TUI framework (Ink) or duplicate width/color helpers —
  see [No new dependencies](#no-new-dependencies--own-the-render-path).
- Do **not** touch the footer's information set (it is honest state); only its
  spacing / empty-state balance (Move 4) if at all.
- Do **not** add a sidebar in the same change as card framing — different
  layout-math risk; ship framing first, evaluate.
- Do **not** bundle **Step 0** (the `Card` primitive) with Move 1, nor Move 1
  with Move 2 — different failure modes (layout math vs color snap vs ticker
  path); ship Step 0, then Move 1, then layer the rest. See
  [Ship order](#ship-order).

## Grilling log — load-bearing claims verified

Three claims in the moves were design hypotheses, not code-verified, when the doc
was drafted. They were grilled against the codebase on 2026-06-30; findings
folded back into Step 0 / Move 2 / Move 5 above. Recorded here so the anchors
can be re-checked cheaply before implementation.

1. **Step 0 — "extend `box.ts`" was wrong.** `Box` (`packages/tui/src/components/box.ts`)
   is a padding + background container (`paddingX` / `paddingY` / `bgFn`,
   `render` at `:81-132`); it has **no border concept and no `╭─╮` glyph
   rendering**. There is nothing to extend. Step 0 is **create `card.ts`**,
   composing `Box` for inner padding/bg and adding the rounded border. The memo
   pattern is `DynamicBorder` (`dynamic-border.ts:11-38`), a width-keyed
   memoized `─` rule (`:31-38`) — generalize it to top/bottom rules + side
   gutters. Fixed in Step 0 and in [No new dependencies](#no-new-dependencies--own-the-render-path).

2. **Move 2 — `interpolateFg` is 2-stop only.** Signature
   (`color-interpolation.ts:46-57`): `interpolateFg(from: ThemeColor, to:
   ThemeColor, t: number) => ((text) => string) | undefined`. It interpolates
   between **two** `ThemeColor` names and returns `undefined` without truecolor
   or when either color doesn't resolve to a truecolor RGB SGR. The wordmark
   2-stop sweep (`teal → lavender`) and the Move 5 wavefront (`dim → accent`)
   are supported. The H1 "2–3 palette stops (`gold → tealBright → cyanBlue`)"
   via a single `interpolateFg` is **not** — a 3-stop needs two `interpolateFg`
   calls stitched by column, or a multi-stop helper on `lerpRgb` / `rgbFg`
   (`color-interpolation.ts:26-39`). Fixed in Move 2; **shipped** 2026-06-30.

3. **Move 5 — the "spinner opts out of the cache" pattern was misdescribed, and
   the fix is cheaper than the doc implied.** The real pattern is
   `ActivityLineComponent` (`activity-line.ts:52-53, 259-266, 323-328`): a
   component **disables its own `linesCache` while an animation it owns is live**
   (`cacheable = !pending && … && !this.iconEase.active`; `this.linesCache = null`
   while live, re-freeze on settle). The ticker (`tui.ts:740-794`) drives a
   whole-tree `requestRender()` — there is no per-component selective re-render
   and no "sub-component that opts out of a parent cache". So the footer
   (`renderCacheLines` at `footer.ts:125-126`, check `:294-298`, store
   `:482-484`) needs only a `cacheable`-style gate (an `easeActive` flag or
   `displayedFill` in the cache key) — **no sub-component refactor**. This
   lowers Move 5's risk. Fixed in Move 5's cache-interaction bullet and Risk line.

4. **Move 1 — tool frames inline frame math, not `Card` subclass.** `MessageShell`
   extends `Container`, not `Card`, so framed tool blocks duplicate the
   `╭─╮│╰─╯` math inline (`message-shell.ts`) rather than composing the Step 0
   primitive. Acceptable for this batch — same width contract (`SHELL_FRAME_COLS =
   4`), separate memo. A future refactor could compose `Card` if the subclass
   shape allows. **Shipped** 2026-06-30.

5. **Move 4 — `pristine` keyed on the wrong proxy; visual gate caught it.** The
   first implementation defined `pristine = usedTokens === 0 && percent === 0`.
   Unit tests passed because synthetic fixtures set `contextUsage.tokens = 0`
   directly. But in a real session the system prompt + tool schema load ~18k
   wire tokens before the first user turn, so `usedTokens === 0` is unreachable
   and the footer never collapsed — exactly the sparse 2-line state Move 4 was
   meant to fix. The 60/140-col visual gate surfaced it (screenshot showed
   `auto` alone on line 2). Fixed by keying `pristine` on `hasUserTurn()` —
   `session.messages` is genuinely empty on a fresh launch because the system
   prompt lives in `agent.state.systemPrompt`, not `messages`. Tests updated to
   simulate `messages: [{ role: "user", … }]` for active sessions and
   `messages: []` for pristine. **Shipped** 2026-06-30; this is the case study
   for why the visual gate is mandatory even when `npm run check` is green.

## Verification (per AGENTS.md)

- **Batch 1 (Step 0 + Move 3 + Move 5):** `npm run check` green; `@pit/tui`
  `card.test.ts` green; footer tests updated. Visual gate not run (gauge-only
  change; low width-crash risk).
- **Batch 2 (Move 1 + Move 2):** `npm run check` green (2026-06-30);
  `welcome-box.test.ts`, `message-shell.test.ts`,
  `interactive-mode-status.test.ts`, `spinner-cadence.test.ts` green. **Visual
  gate passed** (2026-06-30): 60/140-col tmux run confirmed card framing,
  wordmark + H1 gradient, and editor border render with no width crash.
- **Batch 3 (Move 4):** `npm run check` green (2026-06-30); `footer.test.ts`
  20/20 + related footer tests 23/23. **Visual gate caught a real defect:**
  the first `pristine` implementation keyed on `usedTokens === 0`, unreachable
  once the system prompt loads ~18k wire tokens — the footer never collapsed
  in a real session. Fixed by keying `pristine` on `hasUserTurn()` (no user
  message in `session.messages` yet); tests updated to simulate user messages
  for active sessions. Post-fix visual re-verification pending a re-run.
- `npm run check` (tsgo `erasableSyntaxOnly` + biome + vitest + browser-smoke)
  after every move.
- **Visual verification is mandatory** for these changes — `npm run check` only
  proves it compiles. Render the TUI headless via the
  [`docs/agents/tui-testing.md`](docs/agents/tui-testing.md) tmux recipe, or
  boot a real session, and screenshot narrow (60-col) + wide (140-col) widths.
  A box that crashes at width 64 is a regression even if tests pass.
- Re-run `spinner-cadence.test.ts` if any animated gradient touches the ticker
  path.
- Truecolor vs 256-color: cover both — `interpolateFg` snaps to undefined on
  256-color, so the gradient path needs a discrete fallback assertion.
