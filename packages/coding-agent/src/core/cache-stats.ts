/**
 * Prompt-cache observability — derived purely from per-message `usage`, so it
 * works for every provider that reports cache reads/writes (Anthropic, OpenAI
 * prefix cache, Gemini, DeepSeek disk cache, …). No extra state or hooks: the
 * numbers already live on each assistant message.
 *
 * The point is to make token caching *measurable* instead of guessed: a rising,
 * sustained hit-rate means the cacheable prefix is stable; a collapse mid-session
 * means something volatile slipped into the cached prefix and is forcing re-reads.
 */

import type { Usage } from "@pit/ai";

/** Per-assistant-turn cache breakdown. */
export interface CacheTurnStat {
	/** 1-based index among assistant turns (not raw message index). */
	index: number;
	/** Uncached input (prompt) tokens billed at full rate. */
	input: number;
	/** Tokens served from cache (billed ~10%). */
	cacheRead: number;
	/** Tokens written to cache this turn (billed ~125%). */
	cacheWrite: number;
	/** input + cacheRead + cacheWrite. */
	promptTokens: number;
	/** cacheRead / promptTokens, in [0, 1]. */
	hitRate: number;
}

export interface CacheStats {
	turns: CacheTurnStat[];
	totalInput: number;
	totalCacheRead: number;
	totalCacheWrite: number;
	/** totalInput + totalCacheRead + totalCacheWrite. */
	promptTokens: number;
	/** Aggregate cacheRead / promptTokens, in [0, 1]. */
	hitRate: number;
	/** Cache reads are billed at ~10%, so each saves ~90% vs an uncached read. */
	estReadSavingsTokens: number;
	/**
	 * 1-based assistant-turn index where the hit-rate collapsed after the cache had
	 * already warmed — a heuristic "the cached prefix was invalidated" signal. null
	 * when the hit-rate ramped and held (or there was never enough signal).
	 */
	instabilityTurn: number | null;
	/** Whether any cache activity (read or write) was observed at all. */
	cacheObserved: boolean;
}

/** A read-only view of what this needs from a message: its role and optional usage. */
type UsageMessage = { role: string; usage?: Usage };

/** Compute cache statistics from a transcript. Pure; safe to call every render. */
export function computeCacheStats(messages: ReadonlyArray<UsageMessage>): CacheStats {
	const turns: CacheTurnStat[] = [];
	for (const m of messages) {
		if (m.role !== "assistant" || !m.usage) continue;
		const input = m.usage.input ?? 0;
		const cacheRead = m.usage.cacheRead ?? 0;
		const cacheWrite = m.usage.cacheWrite ?? 0;
		const promptTokens = input + cacheRead + cacheWrite;
		turns.push({
			index: turns.length + 1,
			input,
			cacheRead,
			cacheWrite,
			promptTokens,
			hitRate: promptTokens > 0 ? cacheRead / promptTokens : 0,
		});
	}

	const totalInput = sum(turns, (t) => t.input);
	const totalCacheRead = sum(turns, (t) => t.cacheRead);
	const totalCacheWrite = sum(turns, (t) => t.cacheWrite);
	const promptTokens = totalInput + totalCacheRead + totalCacheWrite;

	return {
		turns,
		totalInput,
		totalCacheRead,
		totalCacheWrite,
		promptTokens,
		hitRate: promptTokens > 0 ? totalCacheRead / promptTokens : 0,
		estReadSavingsTokens: Math.round(totalCacheRead * 0.9),
		instabilityTurn: detectInstability(turns),
		cacheObserved: totalCacheRead + totalCacheWrite > 0,
	};
}

/**
 * Flag the first warmed turn whose hit-rate collapsed to under half of the prior
 * turn's. Only considers turns once the cache has demonstrably warmed (a prior
 * turn reached >= 50% hit-rate), so the cold first turn never trips it.
 */
function detectInstability(turns: CacheTurnStat[]): number | null {
	let warmed = false;
	for (let i = 1; i < turns.length; i++) {
		const prev = turns[i - 1];
		const cur = turns[i];
		if (prev.hitRate >= 0.5) warmed = true;
		if (warmed && cur.promptTokens > 0 && cur.hitRate < prev.hitRate * 0.5) {
			return cur.index;
		}
	}
	return null;
}

function sum(turns: CacheTurnStat[], pick: (t: CacheTurnStat) => number): number {
	let total = 0;
	for (const t of turns) total += pick(t);
	return total;
}
