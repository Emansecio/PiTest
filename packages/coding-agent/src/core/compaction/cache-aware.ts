/**
 * Cache-aware compaction routing.
 *
 * The summarizer has two ways to feed the conversation to the LLM:
 *
 *  - TEXT/SIBLING route (the default, always correct): serialize the window as
 *    plain text into one fresh user message and send it to a cheap sibling model
 *    (haiku/mini/nano/flash/lite). Every serialized token is billed UNCACHED at
 *    the sibling's 1x input rate — its prefix shares nothing with the session's.
 *
 *  - CACHE-READ route: reuse the SESSION prefix (system prompt + live messages +
 *    tool block) that Anthropic already has hot in its prompt cache, and hang the
 *    summarization instruction off a tiny fresh trailing user message. The bulk
 *    (the prefix) is billed at the session model's cacheRead rate (~0.1x), the
 *    tail is uncached but negligible.
 *
 * Which one wins is pure arithmetic, PER REQUEST — never a hardcoded model:
 *     text route   ≈ serializedTokens  × sibling.cost.input     + summaryTokens × sibling.cost.output
 *     cache-read   ≈ prefixWireTokens  × session.cost.cacheRead + summaryTokens × session.cost.output
 * BOTH legs matter. The summary is written by whichever model runs the route, and
 * the session model's output is typically 3-5x the sibling's (Sonnet 15 vs Haiku
 * 4; Opus 75 vs 15) — comparing input alone treated that premium as free and
 * biased every decision pro-cache-read. `serializedTokens` is likewise measured on
 * the TEXT the sibling route actually sends (capped/deduped serialization), not on
 * the raw window: the caps make it materially smaller than the live message
 * estimate, and charging the sibling for tokens it never ships was the second half
 * of the same bias.
 *
 * A 150k window on a Sonnet session (cacheRead 0.3) vs a Haiku sibling (input 1.0)
 * is $0.045 vs $0.15 on the input leg alone — but an 8k summary adds $0.12 to the
 * session side against $0.03 to the sibling's, so the read only wins once the
 * input saving outgrows that premium. An Opus-class session loses on both legs.
 * Delta-summarization shrinks `serializedTokens` (small fold set) while
 * `prefixWireTokens` stays the full window, so the sibling wins those on its own —
 * no special-casing needed.
 *
 * This module is the decision only (pure, exported, testable). Warmth detection
 * and prefix assembly live at the call site (they need session state); the
 * cache-read GENERATION lives in compaction.ts next to the shared summarizer
 * plumbing. Kill-switch: `PIT_NO_CACHE_AWARE_COMPACTION`.
 */

import type { Context, Model } from "@pit/ai";

/**
 * Minimum fractional cost advantage the cache-read route must clear over the
 * text/sibling route before it is chosen. The cache-read wire tail is always
 * fresh and a read can partially miss (only the longest cached prefix hits), so
 * a thin arithmetic edge is not worth the risk — demand a real margin.
 */
export const CACHE_AWARE_MIN_ADVANTAGE = 0.25;

/**
 * Minimum fraction of the LIVE window the fold set must cover for the
 * cache-read route to be eligible. The cached prefix is byte-identical to the
 * ENTIRE live window (that identity is what makes the cache hit), so the
 * instruction "summarize the messages above" scopes the summary to everything
 * on the wire — there is no way to send only the fold set without losing the
 * hit. When the fold set is only part of the window (incremental compaction
 * with a large keep-window), the cache-read summary would cover kept messages
 * that stay verbatim below it: diluted scope + conceptual duplication. Only
 * take the route when fold ≈ window (in practice: the first big compaction).
 */
export const CACHE_AWARE_MIN_FOLD_COVERAGE = 0.9;

/** USD per 1M tokens, per token class — the shape of `Model.cost`. */
export type ModelCost = Model<any>["cost"];

export interface CacheAwareCostInputs {
	/**
	 * PRICING input for the text/sibling route: fresh uncached tokens it actually
	 * sends. MUST be measured on the serialized prompt that route ships (tool
	 * results capped, consecutive same-resource ops deduped), not on the raw
	 * window — the caps make the real payload materially smaller. Never compare it
	 * against {@link liveMessageTokens}: different scales (see foldMessageTokens).
	 */
	siblingInputTokens: number;
	/**
	 * COVERAGE input: raw message-token estimate of the fold set, on the SAME scale
	 * as {@link liveMessageTokens} (both from `sumMessageTokens`). Kept separate
	 * from `siblingInputTokens` precisely because the serialized payload is a
	 * different, systematically smaller scale — mixing them would make the scope
	 * guard below read every window as partial.
	 */
	foldMessageTokens: number;
	/** Session-prefix tokens the cache-read route re-reads from a hot cache. */
	cacheReadTokens: number;
	/**
	 * Expected OUTPUT tokens of the summary. The same summary is paid for on both
	 * routes but at different rates (sibling output vs SESSION output), so it never
	 * cancels out. Callers estimate it (see `expectedSummaryOutputTokens` in
	 * summarize.ts); 0 drops the term entirely — the legacy input-only arithmetic.
	 */
	expectedSummaryTokens: number;
	/**
	 * Message tokens of the ENTIRE live window. The cache-read summary scopes to
	 * all of it (see {@link CACHE_AWARE_MIN_FOLD_COVERAGE}), so the route is only
	 * eligible when the fold set ({@link foldMessageTokens}) covers ~all of this.
	 * 0 or absent → coverage unknown → sibling.
	 */
	liveMessageTokens: number;
	/** Text/sibling route model cost (USD / 1M); undefined → no arithmetic. */
	siblingCost: ModelCost | undefined;
	/** Session model cost (USD / 1M); undefined → no arithmetic. */
	sessionCost: ModelCost | undefined;
	/** Whether the session prefix is hot enough to bet on a cache read. */
	warm: boolean;
	/** Override the min advantage (tests); defaults to {@link CACHE_AWARE_MIN_ADVANTAGE}. */
	minAdvantage?: number;
	/** Override the min fold coverage (tests); defaults to {@link CACHE_AWARE_MIN_FOLD_COVERAGE}. */
	minFoldCoverage?: number;
}

export type CacheAwareRoute = "cache-read" | "sibling";

export interface CacheAwareDecision {
	route: CacheAwareRoute;
	/** Estimated USD for the text/sibling route (input × sibling input + summary × sibling output). */
	siblingCostUsd: number;
	/** Estimated USD for the cache-read route (prefix × cacheRead + summary × SESSION output). */
	cacheReadCostUsd: number;
	/** Machine-readable reason, surfaced in the `compaction.cache-aware` diagnostic. */
	reason: "cold" | "no-cost-data" | "no-tokens" | "fold-partial" | "sibling-cheaper" | "cache-read-cheaper";
}

/** True for a usable USD/1M rate: a finite positive number (0 = free-or-unknown pricing). */
function usableRate(rate: number | undefined): rate is number {
	return typeof rate === "number" && Number.isFinite(rate) && rate > 0;
}

/**
 * Decide the summarization route from the two-route arithmetic (input leg +
 * summary-output leg, see the module header). Pure. Any uncertainty (cold prefix,
 * missing/zero cost data on ANY rate the arithmetic uses, zero token counts, or a
 * cache-read win thinner than the margin) resolves to the always-correct sibling
 * route — the cache-read route is only taken on a clear, warm win.
 */
export function decideCacheAwareRoute(input: CacheAwareCostInputs): CacheAwareDecision {
	const minAdvantage = input.minAdvantage ?? CACHE_AWARE_MIN_ADVANTAGE;
	const sibRate = input.siblingCost?.input;
	const cacheRate = input.sessionCost?.cacheRead;
	const summaryTokens = input.expectedSummaryTokens > 0 ? input.expectedSummaryTokens : 0;
	const sibOutRate = input.siblingCost?.output;
	const sessionOutRate = input.sessionCost?.output;
	// The comparison is only meaningful with positive, finite rates on every leg it
	// uses; a zero rate means free-or-unknown pricing, which we do not gamble on.
	// The output rates are only required when a summary size is actually claimed —
	// summaryTokens=0 degrades to the input-only arithmetic instead of bailing.
	const haveCostData =
		usableRate(sibRate) &&
		usableRate(cacheRate) &&
		(summaryTokens === 0 || (usableRate(sibOutRate) && usableRate(sessionOutRate)));
	const siblingCostUsd = haveCostData
		? (input.siblingInputTokens * (sibRate as number) + summaryTokens * (sibOutRate ?? 0)) / 1_000_000
		: 0;
	const cacheReadCostUsd = haveCostData
		? (input.cacheReadTokens * (cacheRate as number) + summaryTokens * (sessionOutRate ?? 0)) / 1_000_000
		: 0;

	const bail = (reason: CacheAwareDecision["reason"]): CacheAwareDecision => ({
		route: "sibling",
		siblingCostUsd,
		cacheReadCostUsd,
		reason,
	});

	if (!input.warm) return bail("cold");
	if (!haveCostData) return bail("no-cost-data");
	if (input.siblingInputTokens <= 0 || input.cacheReadTokens <= 0) return bail("no-tokens");

	// Scope guard: the cache-read summary covers the WHOLE live window (the wire
	// prefix is the window — that identity is the cache hit). If the fold set is
	// only part of it, the summary would also cover kept-verbatim messages —
	// diluted and duplicated. Unknown live size (0) is treated as no coverage.
	// Both sides of this comparison are raw message-token estimates — NEVER the
	// serialized `siblingInputTokens`, whose caps would read as a partial fold.
	const minFoldCoverage = input.minFoldCoverage ?? CACHE_AWARE_MIN_FOLD_COVERAGE;
	if (!(input.liveMessageTokens > 0) || input.foldMessageTokens < input.liveMessageTokens * minFoldCoverage) {
		return bail("fold-partial");
	}

	// Cache-read must be at most (1 - margin) of the sibling cost. Ties and thin
	// wins fall to the sibling.
	if (cacheReadCostUsd <= siblingCostUsd * (1 - minAdvantage)) {
		return { route: "cache-read", siblingCostUsd, cacheReadCostUsd, reason: "cache-read-cheaper" };
	}
	return { route: "sibling", siblingCostUsd, cacheReadCostUsd, reason: "sibling-cheaper" };
}

/**
 * Everything the cache-read GENERATION route needs, assembled at the call site
 * from live session state (which the pure summarizer in compaction.ts cannot
 * reach). Present only when every warmth/eligibility gate passed — its mere
 * existence means the prefix is hot; `warm` stays for the arithmetic and tests.
 */
export interface CacheAwareGeneration {
	/** Session model — its cached prefix is what the cache-read route re-reads. */
	sessionModel: Model<any>;
	sessionApiKey: string | undefined;
	sessionHeaders: Record<string, string> | undefined;
	/**
	 * Provider-side cache routing identity of the session's prefix. This route
	 * exists to RE-READ that prefix, so it has to ask for it on the same shard a
	 * real turn would; an unkeyed request can land elsewhere and miss the very
	 * cache the arithmetic assumed was hot.
	 */
	sessionPromptCacheKey: string | undefined;
	sessionId: string | undefined;
	/**
	 * Assemble the prefix byte-for-byte identical to the real send path (system
	 * prompt + convertToLlm messages + lazy-compacted tool block) so the cache
	 * hits. Async because message conversion is.
	 */
	buildContext: () => Promise<Context>;
	/** True when the prefix is hot (within TTL, cache demonstrated). */
	warm: boolean;
	/** Session-prefix wire tokens — the cache-read side of the arithmetic. */
	prefixWireTokens: number;
	/** Message tokens of the entire live window — fold-coverage guard input (see CACHE_AWARE_MIN_FOLD_COVERAGE). */
	liveMessageTokens: number;
	/** Effective cache retention ("short" | "long"), for the diagnostic. */
	retention: string;
}
