# Prevention layers — audit findings (2026-07-02)

> Companion to [`prevention-layers.md`](prevention-layers.md). That document is the **map**
> (what exists, in execution order); this one is the **audit** — per-layer assessment of
> implementation vs documentation, concrete weaknesses with anchors, and a prioritized
> backlog of improvements. Nothing here is implemented yet unless marked; this is the
> decision basis for whether/what to build.
>
> Method: three parallel code audits (one per band group) plus manual verification of the
> highest-impact claims (firewall registration order, destructive-guard scope and gaps,
> verification-gate wiring). Findings marked **[verified]** were confirmed by direct code
> reading; the rest come from the audit sweep and were spot-checked.

## Overall verdict

The layered architecture is sound and better than most agent harnesses: preventive before
corrective, fixed load-bearing ordering, fail-open design with per-guard env-flag opt-outs,
and a doc philosophy ("strengthen the existing layer, don't add a parallel one") that keeps
the pipeline coherent. The real issues found were:

1. **Doc drift** — the documented Band B order was wrong and two major layers (verification
   gate, overthink guard) were missing from the map entirely. *(Fixed in `prevention-layers.md`
   on 2026-07-02; recorded here for history.)*
2. **A few genuine guard gaps** — command substitution in the destructive guard, symlink/case
   handling in path guards, error-hint coverage for half the tools.
3. **Opacity** — several load-bearing behaviors (failure-budget carryover, presend
   re-estimate) were documented only in code comments or tests.

---

## Band A — around the model (per turn)

| layer | status | key findings |
|-|-|-|
| transformContext | OK | **No timeout** — a hung hook wedges the whole turn; hook chain has no per-hook isolation (one throw kills the turn, no recovery). No kill-switch. |
| compaction / presend overflow | OK | `PRESEND_OVERFLOW_RATIO = 0.95` hardcoded (`agent-session-compaction.ts:44`); hard cliff, no soft ramp. If overflow recovery fails once, `overflowRecoveryAttempted` latches and later calls silently return false. The post-await re-estimate exists and works (now documented in the map). |
| system-prompt / dynamic marker | OK | Marker is a NUL-wrapped string; no validation that it is present — a custom prompt without it silently loses the cached prefix. No diagnostic on marker position. |
| plan-mode prompt | OK | Compliance is delegated to the Band B permissions firewall (correct). No turn-count nudge if the model never calls `exit_plan`; plan-mode re-entry can inject a second `<plan_mode>` block. |
| cache breakpoints | OK | 4 Anthropic breakpoints as documented; `ttl: "1h"` gated per provider; Fireworks disables caching entirely with no TTL fallback. No per-message cache control. |
| connect-guard | OK | 60s default, races user abort correctly. Orphaned `create()` rejection is swallowed by design. No per-provider timeout override. |
| idle-timeout | OK | 120s default, re-armed per chunk. **No adaptive backoff** — a consistently slow provider re-fires the same timeout on every retry. The no-await `iterator.return()` in `finally` is deliberate (frozen-socket deadlock) and fragile to refactors — comment guards it. |
| TTSR matcher | OK | Rolling buffer hardcoded at 2048 chars — a rule that needs a longer match span misses **silently**. `MAX_TTSR_RETRIES_PER_TURN = 3` hardcoded. No rule priority; first match wins. |
| overthink guard | OK (was undocumented) | Per-model-tier thresholds (weak ~1000 / frontier ~2500 thinking tokens), max 2 retries/turn, `watchTextDelta` for open models that reason in plain text. `seenThinkingDelta` latch prevents double-counting. Opt out `PIT_NO_OVERTHINK_GUARD=1`. |
| thinking cap | OK (was undocumented) | `capThinkingForContext` trims stale reasoning to ~1.5k chars head+tail during compaction serialize; protected recent turns never trimmed. Opt out `PIT_NO_THINKING_CAP=1`. |

**Band A improvement candidates**
- A1. Timeout around `transformContext` (30–60s) — currently the only unbounded await in the turn path.
- A2. Make `PRESEND_OVERFLOW_RATIO` and the TTSR rolling-buffer size configurable (or derive the buffer from the compiled rules' max span).
- A3. Adaptive backoff on repeated idle-timeouts (×1.5 per retry, cap ~300s); consider scaling the baseline for `reasoning: true` models.
- A4. Diagnostic when the dynamic marker is missing from a custom system prompt.

---

## Band B — before a tool runs (preventive)

**[verified] Registration order** (`built-ins/index.ts:92-119` + `grounding-guard-registry.ts:38-44`):
`permissions → read-guard → edit-precondition → learned-error → symbol → import →
erasable-syntax → path → pattern → bash-grounding → destructive-command` (patch-audit is
`tool_result`, Band C). The map previously listed learned-error last and destructive-command
before grounding — fixed.

| guard | status | key findings |
|-|-|-|
| unknown-tool | OK | Hardcoded fuzzy limits (max distance 3, 16 tools listed). Fallback hint provider is fail-open with no timeout. |
| prepareArguments | OK | Schema-aware for MCP loose-schema tools. **Asymmetry**: JSON-stringified-array coercion and `stripNullishOptionalArgs` only run for MCP tools — a built-in tool receiving `edits` as a JSON string fails validation instead of being auto-repaired. Alias lists are duplicated between argument-prep and read-guard's own extraction (both must be updated together). |
| tool-rewrite registry | OK | `auto` rewrites are silent — no diagnostic trail of which rule rewrote what (debugging opaque transformations requires adding logging). |
| validateToolArguments | OK | TypeBox + coercion + "did you mean" as documented. No instrumentation on how often `stripNullishOptionalArgs` fires. |
| permissions | OK | No timeout on a custom checker. |
| read-guard | OK | **No symlink resolution** — read of a link and edit of its target (or vice versa) don't match. Post-compaction edits require verbatim oldText (deliberate strictness). `write` to a new file is intentionally unguarded. |
| edit-precondition | OK | Dry-run sees the pre-batch file only (fire-once per path per turn — intentional). No timeout on `computeEditsDiff`. |
| learned-error-guard | OK | **Exact-args fingerprint only** — `const x = 1` vs `const x=1` don't match, so learned lessons rarely re-fire in practice. `minOccurrences=3 / minSessions=2` hardcoded. Lazy disk scan on first call can stall if the store is large. Parent-only (not propagated to subagents) — deliberate. |
| symbol-grounding | OK | LSP authority fail-open when all servers error; 5s index/cache TTL means just-created symbols pass unverified (allow-by-default — correct bias). Per-server 8s timeout can stack across N servers. |
| import-grounding | attention | **[verified risk] Edit-content reconstruction uses the first `indexOf(oldText)` occurrence** — a repeated oldText reconstructs the wrong line and validates the wrong import. Monorepo workspace detection best-effort; re-exported packages can be falsely blocked. |
| erasable-syntax | OK | Scans newText fragments only (an enum split across oldText+newText boundary is missed — narrow window). tsconfig enforcement check cached for the whole session. |
| path-grounding | attention | No `realpath` resolution; **case-sensitive comparison on case-insensitive filesystems (Windows/macOS) can false-block** a path the tool would accept. Fuzzy candidates only from the immediate parent listing. |
| pattern-grounding | OK | Syntax-only (no ReDoS/complexity analysis — a `(a+)+b` passes and hangs the tool instead). |
| bash-grounding | OK | package.json scripts cached once per session — stale after the model itself edits package.json. Only `npm/pnpm/yarn run`; `npx` not covered. |
| destructive-command-guard | **gaps** | **[verified] It is a fire-once speed bump, not a block** — re-issuing runs the command (by design; the catastrophic `/`/`~` tier is the deny-floor's job). **[verified] No command-substitution handling**: `rm -rf $(…)`, backticks, `eval`, `bash -c '…'` pass unanalyzed. Bash-syntax only: PowerShell destructive forms (`Remove-Item -Recurse -Force`, `git clean` aliases) are invisible — relevant on Windows hosts. Fire-once key is per-segment, so reordered compound commands get fresh keys. |

**Band B improvement candidates**
- B1. **Destructive guard: treat the *presence* of command substitution/`eval` inside an
  otherwise-destructive segment as a block reason** (no need to expand it — flag it), and add
  the PowerShell destructive vocabulary. Highest-value guard fix.
- B2. `realpath()` resolution in read-guard + path-grounding; case-insensitive path comparison
  on win32/darwin.
- B3. Import-grounding: reconstruct the edited file with the same occurrence-selection logic
  the edit tool uses (or all occurrences), not first-`indexOf`.
- B4. Learned-error: normalize fingerprints (whitespace, key order) or store variants so
  lessons actually re-fire.
- B5. Extend array-coercion/`stripNullishOptionalArgs` to built-in tools (parity with MCP path).
- B6. Bash-grounding: invalidate the scripts cache when a write/edit touches a package.json.

---

## Band C — after a tool runs (corrective)

| layer | status | key findings |
|-|-|-|
| tool-error-hints | **coverage gap** | Excellent depth where it exists — bash (11 rules), edit/edit_v2 (6), read (1), generic (2). **Zero rules for `write`, `find`, `grep`, `ls`, and ~50 other tools** — the model sees raw errors exactly where a 5-line hint would recover in one round-trip. Learned-error hint rules are lazy-loaded (first error may pay a disk scan) with sane thresholds (3 occurrences / 2 sessions / max 32 rules). Dedup is by hint text, not rule id. |
| repair note | OK | Policy gating (ON for weak/open providers, OFF for native frontier) is well designed. Re-evaluated per model switch mid-session without user visibility (minor). Context cost ~100–300 chars per repaired call on chatty weak models. |
| patch-audit | OK | Risk thresholds hardcoded (medium/high). Fail-open, opt out `PIT_NO_PATCH_AUDIT=1`. |
| read-guard mtime re-stamp | OK | Post-edit re-stamp prevents false drift. Content hash computed lazily on drift comparison only — a very fast external change inside the mtime-granularity window could slip (narrow race). |
| verification gate | OK (was undocumented) | Armed by successful file mutations; runs auto-detected check (check → typecheck → lint → test → local `tsc --noEmit` → syntax-only fallback); failure re-injected up to `verification.maxAttempts` (recovery-adjusted, cap 5); exhaustion forbids "done". Weaknesses: output cap can truncate the failing part of a long test run; command auto-detection is package.json-scripts-based and fragile in monorepos with conditional/workspace scripts; syntax-only fallback unbounded. |
| pending-checks drain | OK (was undocumented) | Background verification-class jobs drain before handoff independent of `verification.enabled`. |

**Band C improvement candidates**
- C1. **Error-hint rules for `write`/`find`/`grep`/`ls`** (ENOENT, permission, pattern syntax,
  "did you mean" path) — lowest effort / highest impact item in the whole audit.
- C2. Verification gate: keep the *tail* of failing output (the summary/failures usually sit
  at the end) rather than a head-biased cap; explicit `verification.command` recommendation for
  monorepos in docs.
- C3. Telemetry: count hint-rule fires per rule id to find dead/noisy rules.

---

## Band D — session / turn lifecycle

| layer | status | key findings |
|-|-|-|
| before_agent_start (task-rigor, mcp) | OK | MCP connect budget ~90ms before skipping — slow (network/SSH) MCP servers are dropped **silently**; the model never learns the server exists. |
| turn_start / session_before_compact | OK | Edit-precondition reset and read-guard migration work as documented. `ReadDedupeStore` clearing is controlled by env (`PIT_READ_DEDUPE`) rather than an explicit documented hook. |
| doom-loop | OK | Result-aware tiers with structured tier-3 recovery and a relapse cap before hard abort. Counts, not duration — "stuck for 5 turns" and "stuck for 50" look the same until thresholds fire. |
| result-loop / cross-error / repeating-pattern | OK | Thresholds hardcoded. Pattern signature is tool-sequence only (`[read, edit, bash]` on file A and file B collide — acceptable coarseness). |
| stagnation | OK | Mutation detection by tool name only (doesn't check the mutation succeeded) — leans false-negative on purpose. |
| todo-cadence | OK | `mutatedWithoutTodo` fires on the first mutation with no grace period for multi-file batches. |
| failure-budget | **opacity** | Per-turn per-tool-name budget (default 3) with **cross-turn carryover via half-life decay (`floor(count/2)` at turn start)** — load-bearing and documented nowhere user-facing. Unrelated failures across turns can accumulate into an early escalation that looks arbitrary. |
| session-recovery | OK | lean→guided→strict with weighted signals (rolling window of 8), de-escalation on clean streaks (5/5/10). Design is right. Gaps: **narration steer only on lean→guided** — guided→strict tightens thresholds without telling the model why; signal weights are flat-ish (one failure-budget fire ≈ one doom-loop tier-1); escalations logged to `quality.recovery` but not surfaced in the UI. |

**Band D improvement candidates**
- D1. Document failure-budget carryover in user-facing settings docs (and consider
  `carryover: false` guidance for CI/batch runs).
- D2. Narration steer on guided→strict, not just lean→guided.
- D3. Make MCP connect timeout configurable (`mcp.connectTimeoutMs`) and emit a one-line
  notice when a server is skipped.
- D4. Surface recovery-level changes in the UI/footer (currently telemetry-only).

---

## Sufficient as-is (do not touch)

Cache breakpoints, connect-guard, idle-timeout core, plan-mode prompt, patch-audit,
edit-precondition, erasable-syntax preflight, repair-note policy, and the session-recovery
core design. Mature layers where changes carry more risk than value.

## Prioritized backlog

**Status: all 10 items implemented on 2026-07-02** (items 2-10 via parallel agent implementation,
verified by the full check gate). Implementation notes below each item.

| # | item | band | status |
|-|-|-|-|
| 1 | Fix the map: Band B order, speed-bump wording, add verification gate / overthink / thinking cap / presend re-estimate | doc | **done** |
| 2 | C1 — error hints for write/find/grep/ls | C | **done** — 9 rules (`write-enoent-path-invalid`, `write-permission-denied`, `write-target-is-directory`, `find-search-path-not-found`, `find-invalid-glob`, `grep-search-path-not-found`, `grep-invalid-regex`, `ls-path-not-found`, `ls-not-a-directory`), matched against the tools' real error strings, with per-tool `disable*Rules` flags |
| 3 | B1 — destructive guard: substitution/`eval` as block reason + PowerShell vocabulary | B | **done** — destructive-shaped segments with `$(…)`/backtick/`eval`/`sh -c` targets block-once as opaque; `Remove-Item -Recurse/-Force`, `rd /s`, `del /s`, glob `Clear-Content` recognized (incl. through `powershell -Command` wrappers) |
| 3b | **deny-floor gap found during B1**: `BUILTIN_DANGEROUS_COMMANDS` had zero PowerShell/cmd catastrophic coverage — `Remove-Item -Recurse -Force C:\` had no hard block anywhere on Windows | B | **done** — drive-root/`/`/`~` Remove-Item, `rd /s`/`del /s` on drive roots, `Clear-Disk`/`Format-Volume`/`format X:` added to `permissions/types.ts` |
| 4 | B2 — realpath + case-insensitive path comparison | B | **done** — `canonicalPathKey`/`sameCanonicalName` in `core/tools/path-utils.ts`; read-guard keys canonicalized, path-grounding case-folds on win32/darwin (keys only, user-visible paths untouched) |
| 5 | A1 — transformContext timeout | A | **done** — 60s default, `PIT_TRANSFORM_CONTEXT_TIMEOUT_MS` override (0 disables); timeout THROWS (never silently skips a load-bearing transform) via the existing terminal-failure path |
| 6 | D2 — narration on guided→strict | D | **done** — one-shot steer with distinct customType `pi.session-recovery-narration-strict`, latch re-arms per escalation |
| 7 | B4 — learned-error fingerprint normalization | B | **done** — whitespace-run collapse, path-separator/drive-case folding; dual-index (exact + normalized) keeps every legacy on-disk fingerprint firing byte-for-byte, no store migration |
| 8 | B3 — import-grounding reconstruction fidelity | B | **done** — mirrors the edit tool via shared `countSubstring`: ambiguous oldText → skip (fail-open, the edit errors anyway), `replaceAll` → all occurrences reconstructed |
| 9 | D1/D3 — failure-budget docs, MCP timeout config | D | **done** — carryover half-life documented in `packages/coding-agent/docs/settings.md`; `mcp.connectTimeoutMs` setting + one-line `mcp.notice` message when a server is skipped by the budget |
| 10 | A2/A3 — configurable presend ratio / TTSR buffer, idle backoff | A | **done** — `PIT_PRESEND_OVERFLOW_RATIO` (clamp [0.5, 0.99]), `PIT_TTSR_BUFFER_CHARS` (clamp [512, 65536]) + warn-once when a rule pattern exceeds the buffer; idle timeout ×1.5 per consecutive idle retry, cap 300s, reset on success |

**Update 2026-07-12: the six deferred candidates are now ALL implemented.**

| # | item | where |
|-|-|-|
| A4 | marker diagnostic | `_checkDynamicMarkerPresence` (`agent-session.ts`) — warn-once `quality.cache-marker` diagnostic when a custom system prompt omits `SYSTEM_PROMPT_DYNAMIC_MARKER` (or places it at offset 0) |
| B5 | array-coercion parity for built-in tools | `coerceJsonStringArrays` (`packages/ai/src/utils/validation-coerce.ts`), run by `validateToolArguments` on the slow path — a JSON-stringified array for an `array`-typed field self-corrects for TypeBox/built-in tools, matching the MCP loose-schema path. Conservative: declared properties only, skips fields that also accept `string` |
| B6 | bash-grounding cache invalidation | `bash-grounding-extension.ts` — a successful `write`/`edit`/`edit_v2`/`ast_edit` on any `package.json` drops the session scripts cache (covered by `PIT_NO_BASH_GROUNDING`) |
| C2 | tail-biased verification output | `summarizeCheckFailure` + `clampTailBiased` (`core/verification/failure-summary.ts`) — head sample (3 lines / ~20% chars) + dominant tail with explicit truncation marker; capture in `verification.ts` is tail-capped |
| C3 | hint-rule fire telemetry | `hint.fired` diagnostics per rule id (`agent-loop.applyToolErrorHints`) aggregated by `HintFireTally` (`core/telemetry/hint-fire-tally.ts`, bounded at 128 ids + overflow bucket) into the session summary's `hintFires` — dead/noisy hint rules are now measurable. Covered by `PIT_NO_TELEMETRY_SINK` |
| D4 | recovery level in UI | footer renders a `recovery:<level>` chip at `guided`/`strict` (nothing at `lean`); `setRecoveryLevelChangeListener` repaints the instant the level changes |
