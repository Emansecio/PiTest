# Autoresearch ideas (deferred / rejected)

## Rejected after measurement

### Persistence async-queue (commit d83acb6, run 12)
**Microbench claim**: `scripts/bench-persistence.mts` shows async-queue 279x
faster than `appendFileSync` (8.15ms → 0.029ms).

**Reality**: `scripts/bench-persistence-realistic.mts` measures end-to-end
wall over 30 turns × 5 entries × 50ms idle. Both backends land at ~380ms
persistence-only cost (idle removed). Queue saves 2-4ms total over the
whole session.

**Why microbench lied**: the timed region was hot-path only (caller returns
after pushing to in-memory queue). Disk I/O still happens in background, and
the OS-level fsync work dominates. JS event loop reclaim only matters if
there's other JS to run during the I/O — there isn't between back-to-back
`appendMessage` calls.

**Lesson**: any "Nx microbench" win must be re-validated with realistic
burst+idle pattern before implementation.

## Open ideas (not yet investigated)

- **Compaction LLM call as primary cost driver**. Per autoresearch run 9
  ground truth, `emit_session_start_ms=42` and `emit_session_shutdown_ms=14`
  are already small. Real per-turn latency is dominated by the provider call
  itself. Investigate: can compaction summary use a faster model than the
  main model? `claude-haiku-4-5` for compaction would reduce compaction wall
  from 10-30s → 2-5s. Quality risk: summary fidelity.

- **Cache invalidation triggers**. Anthropic 1h cache invalidates on any
  prefix mutation. Audit what writes during a turn touch the cached prefix
  (AGENTS.md re-read? skills list change? memory file append?). Each
  invalidation = full re-process of 25k tokens at ~1ms/token.

- **Skill load lazy**. 99 installed skills sit in prompt as titles+
  descriptions. Load full SKILL.md content on-demand when the agent uses
  the skill, not eagerly. Saves 5-15k tokens of prefix per session.

- **Tool result truncation policy**. Bash output truncated to 2000 lines /
  50KB. Large outputs still consume the full byte budget. Investigate:
  summarize-then-discard for results >10KB that the agent didn't reference
  in the next turn.

- **before_provider_request bench harness**. Run 9 noted
  `emit_bpr_ms` was never captured (provider call failed pre-emit). Add a
  synthetic 50ms-sleep handler test to bench-startup with N=10 to show
  parallelization gain deterministically. Status: deferred — needs new
  test harness, not a settings flip.
