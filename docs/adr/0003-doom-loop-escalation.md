# ADR-0003: Doom Loop Escalation Strategy

## Status
Accepted

> **As shipped (reconciled 2026-06-16):** the escalation ladder shipped, but the
> cadence was tuned to **2/4/6** (not 3/5/8 — the tightening anticipated in the Risk
> below). Tier 2 is a **non-blocking steer**, not a user-facing pause, and Tier 3
> runs one structured-recovery pass before aborting on relapse. A complementary
> repeating-pattern detector also catches multi-tool cycles. The tiers/wording below
> are the original provisional design; the mechanism lives in the `agent-session.ts`
> doom-loop handler.

## Context
Models enter doom loops: retrying the same failing command 5-10 times without changing approach. Current behavior (single reminder at threshold=4) is insufficient — models often ignore the reminder and continue looping, burning tokens.

We considered:
1. **Single reminder** — current behavior. Model can ignore.
2. **Immediate abort** — stop after N retries. Aggressive, loses partial progress.
3. **Escalation ladder** — progressive response: warn → pause → abort.

## Decision
Escalation ladder (option 3) with three tiers:

| Tier | Threshold | Action |
|------|-----------|--------|
| 1 | 3 consecutive identical calls | Inject reminder: "You're repeating the same action. Change approach." |
| 2 | 5 consecutive identical calls | Pause execution, ask user for guidance |
| 3 | 8 consecutive identical calls | Abort the current turn, report failure |

**Implementation:** Modify existing `ToolCallStats.isInDoomLoop()` to support tiered thresholds. The doom-loop handler in `agent-session.ts` checks tier and dispatches accordingly. Tier 2 emits a pause event (same mechanism as diff-limit). Tier 3 throws an abort error.

**Sequence reset:** After tier 1 reminder, the sequence window resets so the model gets a fresh 3-call window. After tier 2 user guidance, full reset. Tier 3 is terminal for the turn.

## Consequences
- **Positive:** Gives the model a chance to self-correct (tier 1) before involving the user (tier 2) or giving up (tier 3). Saves 50-80% of tokens wasted in current doom loops.
- **Negative:** Tier 2 pause adds friction. Acceptable — if the model can't solve it in 5 tries, human input is needed anyway.
- **Risk:** Tier thresholds may need tuning. Starting conservative (3/5/8). Can tighten later.
