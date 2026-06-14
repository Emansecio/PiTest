# Fusion Mode — Design Spec

**Status:** Spec of record (decisions locked) — v1 scope is **Fusion · Plan**.
**Scope:** A new Orchestration facet for Pit's operating Mode, exposed in the interactive TUI.
**Supersedes:** the original proposal draft (panel-via-internal-subagents, in-process). The
locked approach is **shell-out to the `codex`/`claude` CLIs** (subscription-backed), a
**split judge→writer** synthesizer, and a **Plan-only** first cut.
**Revised:** after a 2× opus 4.8 self-fusion review of this spec against the codebase (all 13
anchors verified; gaps in orchestration-state plumbing (§8.5), capture asymmetry and win32
process-tree kill (§7), and Tier-1 boundary (§14) folded in).

---

## 1. Summary

Fusion adds a second **independent model perspective** to Pit's operating Modes. Instead of
one agent answering a prompt (Solo), Fusion dispatches the same prompt to a **Panel of two
models** running in parallel as **external CLI subprocesses**, then a **Synthesizer** — the
model currently selected via `/model` — reconciles both outputs in two passes (a **judge**
that produces structured analysis, then a **writer** that writes the final grounded answer).

Fusion is not a new permission level. It is the **Orchestration** facet, composing with the
existing `plan`/`auto` **Permission** facet. v1 surfaces a single new cycle stop:

```
Plan  ->  Auto  ->  Fusion · Plan  ->  (back to Plan)
```

- **Panel** = two models, configured with `/fusion`, each run as a `codex` or `claude`
  subprocess in **read-only** mode. Self-fusion (the same model twice) is allowed.
- **Synthesizer** = the default model currently selected via `/model` (the "protagonist").
  Not chosen in `/fusion`.

This mirrors OpenRouter's Fusion (panel + judge + writer) and the community replication
`duolahypercho/fusion-fable` (which shells out to the `codex` CLI and uses the Claude harness
as judge), reproduced inside Pit over its own Mode/footer/settings machinery.

**Why shell-out, not in-process panel:** the primary reasons are **auth and cost** — each
Panel member runs on its CLI's own **subscription** (`codex` / `claude`), so the Panel adds no
API spend, and each member reuses its CLI's full agentic harness (its own tools, system
prompt, sandbox) for free. A **secondary** corroborator: an *in-process agentic* Panel member
would need the tool loop, and several core managers (`setCurrentGoalManager`,
`setCurrentTodoManager`, `setCurrentLspManager`, …) are module-level singletons that two
concurrent in-process agent loops would clobber — separate CLI processes sidestep that. (The
Synthesizer's judge/writer passes, by contrast, are tool-light raw generations on the
session's own model via `complete()` — `ai/stream.ts:78` — so they incur no clobber and stay
in-process.) This matches the proven fusion-fable approach.

Note on auth granularity: auth/subscription is **per-CLI, not per-member** — a `codex + claude`
Panel uses two subscriptions, but a self-fusion `opus ×2` Panel shares the single `claude`
subscription across both members (see §12 on correlated rate-limiting).

---

## 2. Motivation

OpenRouter's "Fusion beats frontier" results (DRACO benchmark, 100 deep-research tasks) show
that dispatching a prompt to a diverse panel and synthesizing the responses outperforms any
single frontier model:

- `Fable 5 + GPT-5.5` fused (judged by Opus 4.8): **69.0%** vs. best solo (`Fable 5`) **65.3%**.
- `Opus 4.8 + Opus 4.8` self-fusion: **65.5%** vs. solo `Opus 4.8` **58.8%** — a **+6.7**
  point lift from the synthesis step *alone*, with zero model diversity.
- A budget panel beats `GPT-5.5` and `Opus 4.8` solo at a fraction of the cost.

Two takeaways drive this design:

1. **The synthesis step carries real weight** — even fusing one model with itself helps
   (different reasoning paths, tool calls, source selections). So Fusion is worth it even
   with a single provider, and **self-fusion is a supported configuration**.
2. **Diversity is a bonus on top.** Pit's user runs both the `codex` CLI (ChatGPT/Codex
   subscription) and the `claude` CLI (Claude Max subscription), so a heterogeneous
   Codex+Claude Panel is free to assemble from installed CLIs.

The benchmark lift is on **deep-research / reasoning / planning** tasks — which is exactly why
v1 targets **Fusion · Plan** (read-only analysis), the highest-ROI, lowest-risk case.

Sources: https://openrouter.ai/blog/announcements/fusion-beats-frontier/ ·
https://github.com/duolahypercho/fusion-fable

---

## 3. Terminology

- **Mode** — the operating stance the user cycles (footer + cycle key). A Mode is
  `Permission × Orchestration`.
- **Permission** (facet) — `plan` (read-only) or `auto` (guarded writes). Type:
  `PermissionMode = "auto" | "plan"`.
- **Orchestration** (facet) — `solo` (one agent) or `fusion` (Panel + Synthesizer).
- **Panel** — the two models that answer independently, each as a read-only CLI subprocess.
- **Panel member** — one `{ cli, model }` pair (`cli ∈ { "codex", "claude" }`).
- **Synthesizer** — the `/model` default; reconciles the Panel (judge pass + writer pass).
- **I/O surface** — `text` / `json` / `rpc` / `interactive`. NOTE: the code currently calls
  this `Mode` too (`packages/coding-agent/src/cli/args.ts`, `Mode = "text" | "json" | "rpc"`).
  The term is overloaded; disambiguating it (e.g. renaming the I/O surface to `Channel`) is a
  **deferred cosmetic cleanup**, out of scope for this feature.

---

## 4. The Mode model

A Mode is the cross-product of two facets, **not** a flat enum:

```
Mode = { permission: "plan" | "auto", orchestration: "solo" | "fusion" }
```

The permission facet keeps its single enforcement point (`PermissionChecker`); orchestration
is a new flag the agent loop reads to decide whether to run the Fusion path. Storing two
facets (instead of four flat strings) means adding a permission value later does not multiply
the Fusion code.

### v1 cycle (3 stops)

The interactive cycle key (`alt+p`, `app.permission.cycle`) walks:

| Mode | Orchestration | Permission | Panel | Writes | Use |
|-|-|-|-|-|-|
| **Plan** | solo | plan | — | no | Read-only analysis, single agent. |
| **Auto** | solo | auto | — | yes | Default working mode, single agent. |
| **Fusion · Plan** | fusion | plan | 2 models, read-only | no | Hard diagnosis, architecture, research — two perspectives, synthesized. |

In v1, `orchestration = fusion` forces `permission = plan` (the Panel members run read-only,
so there is no write collision and **no git worktree is needed**). **Fusion · Auto** (Panel
members that write) is **deferred** — see §15.

---

## 5. The `/fusion` command

`/fusion` opens a basic selector to configure the Panel — **you pick two models**; Pit infers
which CLI drives each. The pair can be anything: `opus 4.8 + opus 4.8`, `opus 4.8 + gpt-5.5`,
or any other combination.

- **You pick models, not CLIs.** Two slots (A and B); you choose a model for each. The driving
  CLI is inferred from the model family, so the user never thinks about CLIs:
  - Claude models (opus / sonnet / haiku) → driven by the `claude` CLI.
  - GPT / Codex models → driven by the `codex` CLI.
- **Only installed CLIs appear.** Pit probes `codex` and `claude` with a **Windows-aware
  resolver** (`resolveLocalCommand` / `which`, which try `.cmd` / `.exe` / `.ps1` — a raw PATH
  `existsSync` misses the nvm shims); a model whose CLI is absent is hidden. If neither CLI is
  present, `/fusion` explains Fusion needs at least one. (v1 scopes the Panel to Codex + Claude;
  Gemini etc. are deferred.)
- **Self-fusion allowed.** Both slots may hold the same model (`opus ×2`) — still lifts quality
  per the benchmark.
- **Synthesizer is not chosen here** — it is always the `/model` default (shown for reference).
  Changing the `/model` default changes the Synthesizer.
- **Persisted** to `.pit/settings.json` (§9), surviving sessions until changed. Reopen
  `/fusion` to change the pair. The selector reuses the `/model` arrow-picker.

Sketch of the basic selector:

```
  /fusion — Panel (escolha 2 modelos)

  slot A   > opus 4.8       (claude)
             sonnet 4.6     (claude)
             gpt-5.5-codex  (codex)

  slot B     opus 4.8       (claude)
           > gpt-5.5-codex  (codex)

  synthesizer: opus 4.8   (vem do /model)
  enter confirma · esc cancela
```

---

## 6. How a Fusion · Plan turn runs

1. **Fan-out.** The prompt is dispatched to the two Panel members **in parallel**, each as a
   read-only CLI subprocess with `cwd = repo root` (they read the real working tree — no
   worktree, no copy). The runs are fully isolated (separate processes, isolated context;
   **auth is per-CLI** — a self-fusion `opus ×2` Panel shares one subscription, see §12), so
   reasoning paths stay uncorrelated.
2. **Collect.** Both final texts are gathered (see §7 for capture). Timeout per member
   (`fusion.timeoutMs`; `0` falls back to the per-member default in §9 — there is **no**
   turn-level wall-clock to inherit, `settings.timeoutMs` is the `runCheckCommand` cap).
3. **Judge** (Synthesizer pass 1). The `/model` default reads both Panel outputs and emits a
   **structured analysis** (consensus / contradictions / partial coverage / unique insights /
   blind spots, each attributed to a member). Machine-usable (schema-validated) and hideable.
4. **Writer** (Synthesizer pass 2). The `/model` default writes the final answer grounded in
   the analysis — **best-of-both**, not pick-a-winner — streamed to the user as the turn's
   response.

```
         codex  (read-only subprocess) --> output A --,
prompt --|                                            +--> judge --> writer --> final answer
         claude (read-only subprocess) --> output B --'   (/model default, 2 passes)
```

The judge and writer are **sequential generations on the session's own model**, not a second
concurrent session — so they incur no global-manager clobber. In v1 both run tool-light
(judge: no tools, structured output; writer: no tools, composes from the two outputs +
analysis). Giving the writer read-only grounding tools is a Tier-2/backlog refinement.
Mechanically, each pass is a one-shot generation on the session's model — the `complete()`
primitive (`ai/stream.ts:78`) or the `generateBranchSummary` pattern (`agent-session.ts:5153`,
with `model` + `signal` + `reserveTokens`) — and the writer streams its result as the turn
response via the session's `_emit` path.

---

## 7. Grounded CLI invocations (validated on the target machine)

Both CLIs are driven headless, read-only, with deterministic final-output capture. Pit
already drives `claude` headless in `scripts/compare-harness.mts:135` (spawn with
`shell: true` on win32, prompt via stdin, timeout) — the Fusion CLI runner reuses that
pattern.

**Panel A — codex** (`codex exec`, non-interactive):

```
codex exec -s read-only -m <model> -C <cwd> -o <tmpfile> --skip-git-repo-check
  # prompt piped via stdin; final assistant message written to <tmpfile> (-o / --output-last-message)
```

- `-s read-only` — read-only sandbox (no writes, no network escalation).
- `-o <FILE>` — writes **only** the final message (clean capture, no JSONL parsing). `--json`
  is available if event-stream parsing is ever wanted.
- `--output-schema <FILE>` exists (could force the Panel member's final shape) — not used in v1.

**Panel B — claude** (`claude -p`, print/non-interactive):

```
claude -p --output-format json --permission-mode plan --model <model>
  # prompt piped via stdin; parse the `result` field of the JSON for the final text
```

- `--permission-mode plan` — read-only (no edits/writes), Claude's native plan stance.
- `--output-format json` — single JSON object with the final `result` (simpler than
  `stream-json` for capture; `stream-json` remains an option for live rendering in Tier 2).

**Capture is asymmetric — do not copy `compare-harness` blindly.** That script only buffers
**stdout**; `codex`'s final message goes to the `-o <tmpfile>`, *not* stdout. So the codex
member is read from the **file** and the claude member from `JSON.parse(stdout).result`. Use a
**unique tmpfile per member** (a `gpt ×2` self-fusion needs two distinct paths) and delete it
in a `finally`.

**Process-tree kill on Windows.** The reused spawn uses `shell: true` on win32
(`compare-harness.mts:138`), so `child.kill()` kills the *shell* and orphans the `codex` /
`claude` grandchild. The runner must reap the tree — `taskkill /T /F /PID <pid>` on win32 (or
spawn without a shell) — on both timeout and Esc.

**Degradation:** one member failing / timing out → proceed with the surviving member + the
Synthesizer (a `1 + synth` turn) and surface a warning. Both failing → fall back to a normal
**solo** turn on the `/model` default. The turn never hard-fails because Fusion was on.

---

## 8. Codebase anchors (validated, file:line)

Concrete, verified anchors so the implementation reuses what exists:

- **Permission facet:** `packages/coding-agent/src/core/permissions/types.ts:12` —
  `PermissionMode = "auto" | "plan"` (no third value anywhere). Reused unchanged.
- **Mode cycle & footer:** `packages/coding-agent/src/core/built-ins/permissions-extension.ts`
  registers the `permission-cycle` command (~l.91-98; current toggle at l.94
  `checker.mode === "auto" ? "plan" : "auto"`) and updates the footer via `ctx.ui.setStatus`.
  Keybinding `app.permission.cycle` = `alt+p` at `keybindings.ts:86`. The 3-stop cycle and the
  orchestration facet are added here.
- **Toggle precedent:** `packages/coding-agent/examples/extensions/plan-mode/index.ts` — a
  complete user-toggled stance (command + shortcut + footer widget + state surviving resume +
  tool-call interception). The pattern Fusion's footer/state follows.
- **Session + final output:** `core/sdk.ts:228` `createAgentSession(options)`;
  `core/agent-session.ts:2904` `prompt(text): Promise<void>` (resolves void); the final text
  is read from the `agent_end` event (`agent-session.ts:207-211`,
  `{ type: "agent_end", messages, willRetry }`). The Fusion turn branches inside `prompt()`.
- **Model registry:** `core/model-registry.ts:330-401` (`ModelRegistry`); providers
  implemented in `@pit/ai` include `anthropic`, `google`, `openai-completions`,
  `openai-responses`, **`openai-codex-responses`**. Backs both `/model` and `/fusion`'s lists.
- **Settings:** `core/settings-manager.ts:576` (`SettingsManager`) reads `.pit/settings.json`.
  A new top-level `fusion` section is added with a getter (and optional TypeBox validation, as
  `models.json` uses).
- **Subagent/worktree (NOT used in v1):** `core/coordinator/spawn.ts:132-200`
  (`spawnSubagent` exported, `createWorktree` internal → `.pit/worktrees/<task>-<uuid>`,
  detached HEAD, auto-cleanup). These run **in-process** subagents sharing the parent's
  model/auth and tripping the global-manager singletons — which is exactly why v1 uses
  external CLI subprocesses instead. Relevant only if/when Fusion · Auto (§15) is built.
- **Global-manager hazard (why shell-out):** `setCurrentGoalManager`
  (`core/goal/goal-manager.ts`), `setCurrentTodoManager` (`core/todo/todo-manager.ts`),
  `setCurrentToolDiscoveryIndex`, `setCurrentEvalKernelManager`, `setCurrentLspManager`
  (`core/lsp/manager.ts`) are module-level singletons; two in-process sessions clobber each
  other. Separate CLI processes avoid this completely.
- **No existing machinery:** there is **zero** prior fusion / panel / synthesize / ensemble /
  consensus code. The `core/fusion/` module is greenfield.

---

## 8.5 Orchestration state plumbing (the load-bearing wiring)

The spec's biggest gap (flagged **[alta]** by both review panels): §4 says "orchestration is a
flag the agent loop reads", but the existing machinery has **nowhere to put it**.
`PermissionChecker` (`permissions/checker.ts:44-73`) holds only the permission facet; the
`permission-cycle` command (`permissions-extension.ts:91-99`) only calls `checker.updateMode`.
There is no path from the TUI cycle key to `agent-session.prompt()`. Locked plumbing:

- **Owner.** The `orchestration` facet (`"solo" | "fusion"`) is a field on the **`AgentSession`**
  (not on `PermissionChecker`, which stays permission-only). Default `"solo"`.
- **Setter.** Exposed on the **`ExtensionAPI`**, mirroring `setThinkingLevel`
  (`extensions/types.ts:1259`, handler `SetThinkingLevelHandler` `:1511`) — i.e.
  `getOrchestration()` / `setOrchestration(o)`. The `permission-cycle` handler calls it as the
  cycle walks into/out of the `Fusion · Plan` stop.
- **Read point.** `_promptOnce` (`agent-session.ts:3096`) reads the session's `orchestration` at
  the top of the turn: `"fusion"` routes to the Fusion orchestrator, `"solo"` keeps today's path.
- **Footer.** `permissionDisplayLabel` (`permissions-extension.ts:36`) is extended to compose
  `permission × orchestration` (e.g. `fusion · plan`), or a second status key is added.
- **Persistence.** The facet rides the same session-state/resume channel as the permission mode,
  so `Fusion · Plan` survives a resume (the plan-mode example, §8, is the precedent).

Settle this before writing the cycle or the orchestrator — it is the Tier-1 linchpin.

---

## 9. Configuration

A `fusion` section in `.pit/settings.json` (managed by `SettingsManager`):

```jsonc
{
  "fusion": {
    "panel": [
      { "cli": "codex",  "model": "gpt-5.5-codex" },
      { "cli": "claude", "model": "opus" }
    ],
    "timeoutMs": 180000,      // per-member wall-clock cap (ms); no turn-level default to inherit
    "staggerSameCliMs": 400,  // delay between same-CLI members to avoid correlated throttle (§12)
    "showSynthesis": false    // hide the judge's structured block by default
  }
}
```

- `panel` — exactly two members; each `{ cli, model }`. Empty/absent → auto-detect the richest
  installed-CLI default (Tier 2).
- `timeoutMs` — per-member wall-clock cap (ms). Concrete default (e.g. `180000`); **not** an
  inherit of `settings.timeoutMs` (that is the `runCheckCommand` cap, `agent-session.ts:3003`).
- `staggerSameCliMs` — delay before launching a second member on the **same** CLI, to avoid
  correlated rate-limiting on a shared subscription (§12).
- `showSynthesis` — whether the judge's structured analysis is surfaced inline or hidden.

---

## 10. Synthesizer output (split judge → writer)

The Synthesizer runs in two passes on the `/model` default:

**Pass 1 — Judge** (structured, schema-validated, hideable):

- **Consensus** — what both Panel members agree on.
- **Contradictions** — where they disagree, and on what.
- **Partial coverage** — what only one member addressed.
- **Unique insights** — non-obvious points raised by a single member.
- **Blind spots** — gaps both members missed.

Each item is attributed to its source member.

**Pass 2 — Writer** (streamed final answer):

- Reads the judge's analysis + both raw outputs and writes the single reconciled answer,
  **taking the best of each** rather than discarding a member wholesale. One-line rationale
  when it overrides one member in favor of the other.

The structured judge block is hidden by default (`showSynthesis: false`) and surfaced on
demand (`/fusion show`, Tier 2). Splitting judge and writer (vs. a single fused pass) is the
locked choice — it matches OpenRouter's pipeline and trades one extra model pass for cleaner,
more auditable synthesis.

---

## 11. Cost

A Fusion · Plan turn costs roughly **two Panel CLI runs + two Synthesizer passes**
(judge + writer) ≈ **3–4× a Solo turn**, more if Panel members make heavy tool use. The Panel
runs bill against the **CLI subscriptions** (codex/claude); only the judge+writer passes hit
the **`/model` provider's budget** — which is API *or* subscription depending on how that model
is authed (a Claude `/model` default on Max bills the subscription, not API). This is the
intended price of the quality lift, and the reason Fusion is an explicit Mode the user opts into.

---

## 12. Failure & degradation

| Situation | Behavior |
|-|-|
| One Panel member fails / times out | Proceed with the survivor + Synthesizer (`1 + synth`); warn. |
| Both Panel members fail | Fall back to a normal **solo** turn on the `/model` default; warn. |
| A configured CLI is missing at runtime | `/fusion` won't offer it; if a stale config names it, degrade as above. |
| Both members are the **same CLI** | Shared subscription → they tend to **429 together**; stagger launch (`staggerSameCliMs`) and treat "both throttled" as a distinct branch, not two independent failures. |
| Judge pass fails (schema/parse) | Retry once; on second failure, writer composes directly from raw outputs. |
| User interrupts (Esc) | The orchestrator holds its own `_fusionAbort` (mirroring `_branchSummaryAbortController`, `agent-session.ts:457`/`:3990`), aborted inside `interrupt()`; on win32 it must **also `taskkill /T /F`** the subprocess tree (shell-spawn orphans the grandchild — §7). |

---

## 13. Locked decisions

1. Fusion is the **Orchestration facet** of a Mode, composing with the `plan`/`auto`
   permission facet — not a new permission value.
2. A Mode is stored as **two facets** (`permission × orchestration`); the cycle presents the
   meaningful combinations (v1: 3 stops).
3. **Panel = two models run as external CLI subprocesses** (`codex` / `claude`), read-only,
   on per-CLI subscription auth (same-CLI members share one subscription). **Self-fusion is
   allowed.**
4. **Synthesizer = the `/model` default**, run as a **split judge → writer** (two passes).
5. **v1 scope is Fusion · Plan only** (read-only Panel, no worktree, no diff reconciliation).
   Fusion · Auto is deferred (§15).
6. Degradation is **graceful** — a Fusion turn never hard-fails for lack of a Panel member.
7. Config (`fusion.panel/timeoutMs/showSynthesis`) lives in `.pit/settings.json`.

---

## 14. Implementation tiers

**Tier 1 — Núcleo (Fusion · Plan end-to-end):**

1. Orchestration facet (state owner + `ExtensionAPI` setter — §8.5) + 3-stop cycle
   (`Plan → Auto → Fusion · Plan`) + footer label that **composes permission × orchestration**
   (today `permissionDisplayLabel`, `permissions-extension.ts:36`, renders permission only), in
   `permissions-extension.ts` / `keybindings.ts`.
2. `core/fusion/cli-runner.ts` — drives `codex`/`claude` headless read-only (reusing the
   `compare-harness.mts` spawn pattern), captures the final text, enforces timeout, degrades
   gracefully.
3. `core/fusion/orchestrator.ts` — fan-out → collect → judge (structured) → writer (stream);
   wired into `agent-session.prompt()` behind the orchestration flag.
4. `/fusion` command — detect CLIs (Windows-aware resolver, not raw PATH `existsSync` — §5),
   pick the `{ cli, model }` pair (self-fusion allowed), persist to settings. **Includes the
   model-id mapping** (registry id → what `codex -m` / `claude --model` accept), curated to a
   shortlist for v1 — a Tier-1 prerequisite, not a §16 open item.
5. `fusion` settings section + `getFusionSettings()`.

**Tier 2 — Polish:**

6. TUI: two Panel activity lines + a "Synthesizing (judge → writer)" phase (ADR-0005
   two-family rendering precedent).
7. Hideable structured judge block + `/fusion show` to reveal the last analysis.
8. Auto-detect the default Panel (richest installed CLI) when `fusion.panel` is empty.
9. Optional read-only grounding tools for the writer pass.

**Kill-switch:** `PIT_NO_FUSION` (default-off — Fusion is opt-in via the Mode anyway), plus
the per-turn Mode itself is the primary gate.

---

## 15. Deferred / backlog

- **Fusion · Auto** — Panel members that *write*. The hard part is reconciling two concurrent
  diffs. Two candidate strategies (re-decide when built): (a) **plan → synthesize → single
  executor** (the two models plan read-only, the Synthesizer merges, one executor applies —
  captures most of the lift, low risk); (b) **dual-edit in isolated worktrees + diff
  reconciliation** (closer to "two independent attempts", uses `spawnSubagent`/`createWorktree`
  but requires solving the global-manager hazard or running members as separate processes).
- **Panel of N (>2)** — the benchmark and OpenRouter allow it; the config schema already
  generalizes (`panel` is an array).
- **Per-permission Panels** — a different pair for Plan vs Auto (`panelPlan` / `panelAuto`).
- **I/O-surface rename** (`Mode` → `Channel`) to disambiguate the overloaded term.

---

## 16. Open items for the next pass

- (Promoted to Tier 1 — §14.4 — the model-id mapping per CLI is a prerequisite, no longer
  deferred. The remaining nuance: how to *present* the curated shortlist from the ~720-model
  registry.)
- Whether the writer should get read-only tools to verify a claim against the repo (v1: no).
- Live streaming of the two Panel runs vs. show-on-complete (v1: show-on-complete; Tier 2 can
  use `stream-json` / `--json` for live activity).
- Telemetry: record Fusion turns (members used, degradations, judge retries) via the existing
  runtime-diagnostics channel.
