/**
 * Session outcome snapshot — one `{type:"session-summary"}` record written to
 * the diagnostics sink at session shutdown. It labels a whole session with the
 * signals already computed elsewhere: the reactive-recovery snapshot, the
 * verification attempt/failure tally, the runtime-diagnostics counter totals,
 * and (when the transcript is cheaply reachable) the prompt-cache totals.
 *
 * Pure builder: it only reshapes inputs into a compact, flat record. All sources
 * are gathered by the caller so this stays trivially testable and never reaches
 * into the session.
 */

import type { DiagnosticSnapshot } from "@pit/ai";
import type { CacheStats } from "../cache-stats.ts";
import type { RecoverySnapshot } from "../session-recovery.ts";
import type { HintFireTallySnapshot } from "./hint-fire-tally.ts";

/** Verification-gate tally for the session (attempts run, failing attempts). */
export interface VerificationSummary {
	attempts: number;
	failures: number;
}

/** Compact cache totals kept in the summary (the per-turn array is dropped). */
export interface CacheSummary {
	promptTokens: number;
	totalInput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	hitRate: number;
	instabilityTurn: number | null;
	cacheObserved: boolean;
}

/** Prompt-cache prefix rebuild diagnostics (live TUI `/stats` already shows these). */
export interface CachePrefixSummary {
	rebuilds: number;
	reasons: Array<{ reason: string; count: number }>;
}

export interface SessionSummaryRecord {
	type: "session-summary";
	ts: number;
	recovery: RecoverySnapshot;
	verification?: VerificationSummary;
	/** Diagnostics counter totals: overall total plus per-category count. */
	diagnostics: { total: number; counters: Record<string, number> };
	/** Present only when the transcript was reachable to compute cache stats. */
	cache?: CacheSummary;
	/** Present when the session rebuilt the static cache prefix at least once. */
	cachePrefix?: CachePrefixSummary;
	/** Per-rule tally of Tier-4 hint fires; present only when at least one fired. */
	hintFires?: HintFireTallySnapshot;
}

export interface SessionSummaryInput {
	recovery: RecoverySnapshot;
	diagnostics: DiagnosticSnapshot;
	verification?: VerificationSummary;
	cache?: CacheStats;
	cachePrefix?: CachePrefixSummary;
	hintFires?: HintFireTallySnapshot | null;
}

/** Build the flat session-summary record from the gathered session signals. */
export function buildSessionSummaryRecord(input: SessionSummaryInput): SessionSummaryRecord {
	const counters: Record<string, number> = {};
	for (const [category, counter] of Object.entries(input.diagnostics.counters)) {
		counters[category] = counter.count;
	}
	const record: SessionSummaryRecord = {
		type: "session-summary",
		ts: Date.now(),
		recovery: input.recovery,
		diagnostics: { total: input.diagnostics.total, counters },
	};
	if (input.verification) record.verification = input.verification;
	if (input.cache) {
		record.cache = {
			promptTokens: input.cache.promptTokens,
			totalInput: input.cache.totalInput,
			totalCacheRead: input.cache.totalCacheRead,
			totalCacheWrite: input.cache.totalCacheWrite,
			hitRate: input.cache.hitRate,
			instabilityTurn: input.cache.instabilityTurn,
			cacheObserved: input.cache.cacheObserved,
		};
	}
	if (input.cachePrefix && input.cachePrefix.rebuilds > 0) {
		record.cachePrefix = input.cachePrefix;
	}
	if (input.hintFires && input.hintFires.total > 0) {
		record.hintFires = input.hintFires;
	}
	return record;
}
