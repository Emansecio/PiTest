/**
 * Cache-cost arithmetic for the *proactive* (size-driven) context prune.
 *
 * Background — why a prune can cost more than it saves below real pressure:
 * `pruneOldToolOutputs` shrinks tool-results in the MIDDLE of the transcript.
 * Providers cache a stable prefix of the request; the first byte that changes
 * invalidates every cached token from that point to the end of the request. So a
 * mid-history prune forces the provider to re-write ("cold" cache-write) the whole
 * tail from the first pruned message onward, even though we only reclaimed a slice
 * of it.
 *
 *   one-time cost  ≈ (tailTokens − reclaimed) × (cacheWrite − cacheRead)
 *   recurring gain ≈ reclaimed × cacheRead   ... per future turn
 *
 * The recurring gain is the cheaper cache-read we pay on the reclaimed tokens on
 * every subsequent turn (they're simply gone). The window-headroom value of the
 * prune — the other half of the payoff — is deliberately ignored here because in
 * the COMFORTABLE band (below the mid-turn pressure ratio) that headroom is not
 * scarce yet. Under real pressure this whole module is bypassed and the prune runs
 * unconditionally.
 *
 * Amortize the one-time cost over a short recurrence horizon and defer the prune
 * when the savings don't pay it back:
 *
 *   defer  ⇔  reclaimed × cacheRead × HORIZON  <  (tailTokens − reclaimed) × (cacheWrite − cacheRead)
 *
 * Conservative bias notes:
 *  - `cacheWrite` here is the model's *listed* cache-write price (Anthropic ≈ 1.25×
 *    input for the 5-minute tier). A long-retention write costs `@pit/ai`'s
 *    `LONG_CACHE_WRITE_MULTIPLIER` (1.6×) more than that — and long IS the default
 *    for the interactive session — which makes a mid-history invalidation more
 *    expensive than this arithmetic assumes. Feeding the listed rate therefore
 *    UNDER-states the true one-time cost and biases us toward pruning (never
 *    toward over-deferring). Intentional and kept that way now that the effective
 *    rate is derivable: we'd rather occasionally prune when it was marginal than
 *    hold stale bulk in a comfortable window. Pass the scaled rate here only as a
 *    deliberate product change, not as a "fix".
 *  - A short HORIZON (10 turns) means we only prune eagerly when the per-turn read
 *    savings clear the re-write within ~10 turns; anything slower waits for real
 *    pressure (or natural supersession) to reclaim it.
 *
 * This module is pure: numeric inputs → decision. No message walking, no I/O. The
 * caller (agent-session `_pruneContextForProvider`) measures `reclaimed` /
 * `tailTokens` from a throw-away prune probe and resolves the pressure ratio.
 */

/**
 * Turns over which a proactive prune's recurring cache-read savings are amortized
 * against the one-time cost of invalidating (re-writing) the cached tail.
 * Deliberately short: below real context pressure the window-headroom value of
 * pruning is low, so eager pruning only pays when the read savings recoup the
 * re-write quickly.
 */
export const PRUNE_CACHE_ECONOMICS_HORIZON_TURNS = 10;

export interface PruneCacheEconomicsInput {
	/** Tokens the size-prune would reclaim from the middle of the transcript. */
	reclaimedTokens: number;
	/**
	 * Tokens from the first pruned message to the end of the request — the cached
	 * tail the provider must cold-write once the mid-history edit lands.
	 */
	tailTokens: number;
	/** Current occupancy: contextTokens / contextWindow (0..1). */
	occupancy: number;
	/**
	 * Comfortable-band boundary. At or above this ratio we are in the real-pressure
	 * band and never defer (matches the unconditional mid-turn relief path).
	 */
	pressureRatio: number;
	/** model.cost.cacheRead — USD per 1M tokens. */
	cacheReadCostPerMTok: number;
	/** model.cost.cacheWrite — USD per 1M tokens. */
	cacheWriteCostPerMTok: number;
	/** Test seam; defaults to {@link PRUNE_CACHE_ECONOMICS_HORIZON_TURNS}. */
	horizonTurns?: number;
}

export type PruneCacheEconomicsReason =
	/** Occupancy ≥ pressureRatio → real pressure, prune unconditionally. */
	| "pressure-band"
	/** No cache tier / no write premium → nothing to weigh, keep current behavior. */
	| "no-cache-pricing"
	/** Probe reclaimed nothing → no prune to defer. */
	| "nothing-reclaimed"
	/** Recurring read savings cover the one-time re-write within the horizon → prune. */
	| "gain-covers-cost"
	/** Savings fall short over the horizon → defer the size-prune. */
	| "defer-below-horizon";

export interface PruneCacheEconomicsDecision {
	/** True ⇒ skip the size-prune this turn (keep the cached tail intact). */
	defer: boolean;
	reason: PruneCacheEconomicsReason;
	/** Estimated one-time USD cost of the provider re-writing the invalidated tail. */
	oneTimeInvalidationCostUsd: number;
	/** Estimated recurring USD read savings over the horizon. */
	recurringReadSavingsUsd: number;
}

const PER_MTOK = 1_000_000;

/**
 * Decide whether a proactive size-prune should be deferred purely on cache-cost
 * grounds. Pure function — see the module header for the model and the guards.
 */
export function evaluatePruneCacheEconomics(input: PruneCacheEconomicsInput): PruneCacheEconomicsDecision {
	const horizon = input.horizonTurns ?? PRUNE_CACHE_ECONOMICS_HORIZON_TURNS;
	const read = input.cacheReadCostPerMTok;
	const write = input.cacheWriteCostPerMTok;
	// Per-token premium of a cold cache-write over a warm cache-read. This is the
	// marginal price the mid-history invalidation actually costs vs. leaving the
	// tail cached and merely re-reading it.
	const writePremium = write - read;

	const rewrittenTokens = Math.max(0, input.tailTokens - input.reclaimedTokens);
	const oneTimeInvalidationCostUsd = (rewrittenTokens * Math.max(0, writePremium)) / PER_MTOK;
	const recurringReadSavingsUsd = (Math.max(0, input.reclaimedTokens) * Math.max(0, read) * horizon) / PER_MTOK;

	const decision = (defer: boolean, reason: PruneCacheEconomicsReason): PruneCacheEconomicsDecision => ({
		defer,
		reason,
		oneTimeInvalidationCostUsd,
		recurringReadSavingsUsd,
	});

	// Real-pressure band: the window matters now — prune unconditionally (never
	// defer), matching applyMidTurnPressureRelief's unconditional design.
	if (input.occupancy >= input.pressureRatio) return decision(false, "pressure-band");

	// Provider without a real cache-write tier (e.g. codex writes are free) — there
	// is no re-write penalty to amortize, so keep the current always-prune behavior.
	if (!(read > 0) || !(write > 0) || writePremium <= 0) return decision(false, "no-cache-pricing");

	// Probe reclaimed nothing (or firstPrunedIndex missing upstream) — nothing to defer.
	if (!(input.reclaimedTokens > 0)) return decision(false, "nothing-reclaimed");

	// Defer only when the horizon of recurring read savings fails to cover the
	// one-time cold-write of the invalidated tail.
	if (recurringReadSavingsUsd >= oneTimeInvalidationCostUsd) return decision(false, "gain-covers-cost");
	return decision(true, "defer-below-horizon");
}
