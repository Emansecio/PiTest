/**
 * Auto-fallback chain runner for `web_search`. Walks providers in order
 * and returns the first non-empty hit list. Per-provider errors are
 * swallowed so a single broken vendor cannot break the whole chain.
 */

import type { SearchHit, SearchProvider } from "./providers.ts";

export interface ChainResult {
	hits: SearchHit[];
	usedProvider: string;
}

export interface ChainAttempt {
	provider: string;
	error?: string;
	count: number;
}

export interface ChainOutcome extends ChainResult {
	attempts: ChainAttempt[];
}

export async function autoSearchChain(
	query: string,
	limit: number,
	providers: SearchProvider[],
	signal?: AbortSignal,
): Promise<ChainOutcome> {
	if (providers.length === 0) {
		throw new Error(
			"no providers available (set BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, JINA_API_KEY, or PERPLEXITY_API_KEY)",
		);
	}
	const attempts: ChainAttempt[] = [];
	for (const provider of providers) {
		if (signal?.aborted) throw new Error("aborted");
		try {
			const hits = await provider.search(query, limit, signal);
			attempts.push({ provider: provider.name, count: hits.length });
			if (hits.length > 0) {
				return { hits, usedProvider: provider.name, attempts };
			}
		} catch (err) {
			attempts.push({
				provider: provider.name,
				error: err instanceof Error ? err.message : String(err),
				count: 0,
			});
		}
	}
	const summary = attempts.map((a) => `${a.provider}: ${a.error ?? `${a.count} hits`}`).join("; ");
	throw new Error(`all providers failed or returned empty (${summary})`);
}
