# ADR-0002: Diff Size Limit with Pause

## Status
Proposed — never implemented (was incorrectly marked Accepted).

> **Reconciliation note (2026-06-16):** The code was never shipped — a grep for
> `diffLimit|changedLines|DiffLimit|createDiffLimit|diff-limit` across
> `packages/coding-agent/src` returns 0 matches, and the built-in factory array
> registers no diff guard. The "Implementation" paragraph below describes an
> `afterToolCall` extension that does not exist; treat this ADR as a proposal,
> not a record of shipped behavior. If revived, see item **PV2** of
> `docs/optimization/weak-model-uplift-audit.md`: prefer a telemetry / diagnostic
> -only signal over an interactive pause, which conflicts with the autonomous
> `/goal` flow.

## Context
Models frequently over-engineer: a 10-line task becomes 200+ lines with abstractions, helper functions, and speculative error handling. This wastes tokens, introduces bugs, and creates maintenance burden.

We considered:
1. **Prompt-only** — instruct the model to be minimal. No enforcement.
2. **Hard limit** — reject tool calls that would produce large diffs.
3. **Pause + confirm** — allow the changes but pause for user review when threshold exceeded.

## Decision
Pause + confirm (option 3) with a threshold of 300 lines changed per turn. Combined with Karpathy guidelines in the system prompt for prevention.

**Implementation:** Built-in extension that hooks `afterToolCall` for `edit` and `write` tools. Tracks cumulative lines changed in the current turn. When threshold exceeded, emits a pause event that surfaces to the user: "This turn has modified 300+ lines. Continue?"

**Why 300?** Covers 95% of legitimate single-feature implementations. Refactors that legitimately need more can be approved by the user. The number is a default — not configurable initially to avoid analysis paralysis.

## Consequences
- **Positive:** Catches over-engineering before it compounds across multiple files.
- **Negative:** Interrupts legitimate large changes (migrations, generated code). User can always approve.
- **Not caught:** Over-engineering within 300 lines (e.g., unnecessary abstractions in 150 lines). Karpathy prompt guidelines address this softer case.
