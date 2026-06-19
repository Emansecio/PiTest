/**
 * Search provider implementations for the `web_search` tool.
 *
 * Each provider exposes a small `search()` function that hits a vendor HTTP
 * API via `fetch` and returns normalized `SearchHit`s. Providers are bundled
 * by the chain runner; missing env keys make a provider skip silently in
 * auto mode but throw a clear error when the user selects them explicitly.
 */

import { sleep } from "../../utils/sleep.ts";

export interface SearchHit {
	title: string;
	url: string;
	snippet?: string;
	source?: string;
}

export interface SearchProvider {
	name: string;
	envKey: string;
	search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]>;
}

function requireKey(envKey: string, providerName: string): string {
	const key = process.env[envKey];
	if (!key || key.length === 0) {
		throw new Error(`missing env: ${envKey} (required for ${providerName})`);
	}
	return key;
}

function clampLimit(limit: number, max: number): number {
	if (!Number.isFinite(limit) || limit <= 0) return 1;
	return Math.min(Math.floor(limit), max);
}

const FETCH_TIMEOUT_MS = 10_000;
/** Max retries on HTTP 429 before giving up on this provider (the chain then falls through). */
const MAX_429_RETRIES = 2;
/** Base backoff between 429 retries; doubled per attempt, capped, or overridden by Retry-After. */
const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 5_000;

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
	// Per-request timeout: without it a black-hole provider hangs web_search
	// indefinitely and stalls the (serial) fallback chain — the global undici
	// dispatcher is configured with bodyTimeout:0, so this is the only backstop.
	// Compose with any caller signal so an external abort still wins. On HTTP 429
	// we back off and retry (honoring Retry-After) instead of immediately failing
	// over to the next provider, which would burn the chain on a transient limit.
	const external = signal ?? init.signal ?? undefined;
	for (let attempt = 0; ; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		const onExternalAbort = () => controller.abort();
		if (external) {
			if (external.aborted) controller.abort();
			else external.addEventListener("abort", onExternalAbort, { once: true });
		}
		let backoffMs = -1;
		try {
			const res = await fetch(url, { ...init, signal: controller.signal });
			if (res.status === 429 && attempt < MAX_429_RETRIES && !external?.aborted) {
				const retryAfter = Number(res.headers.get("retry-after"));
				backoffMs =
					Number.isFinite(retryAfter) && retryAfter > 0
						? Math.min(retryAfter * 1000, RETRY_MAX_MS)
						: Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS);
			} else {
				if (!res.ok) {
					const text = await res.text().catch(() => "");
					throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
				}
				return (await res.json()) as unknown;
			}
		} finally {
			clearTimeout(timer);
			if (external) external.removeEventListener("abort", onExternalAbort);
		}
		// 429 with retries left: per-attempt timer/listener are already cleared
		// above, so the backoff sleep is governed only by the external signal.
		await sleep(backoffMs, external);
	}
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const braveProvider: SearchProvider = {
	name: "brave",
	envKey: "BRAVE_SEARCH_API_KEY",
	async search(query, limit, signal) {
		const key = requireKey(this.envKey, this.name);
		const count = clampLimit(limit, 20);
		const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
		const data = (await fetchJson(
			url,
			{
				headers: {
					Accept: "application/json",
					"X-Subscription-Token": key,
				},
			},
			signal,
		)) as { web?: { results?: Array<Record<string, unknown>> } };
		const results = Array.isArray(data?.web?.results) ? data.web.results : [];
		const hits: SearchHit[] = [];
		for (const r of results) {
			const title = asString(r.title);
			const link = asString(r.url);
			if (!title || !link) continue;
			hits.push({
				title,
				url: link,
				snippet: asString(r.description),
				source: "brave",
			});
		}
		return hits.slice(0, count);
	},
};

export const tavilyProvider: SearchProvider = {
	name: "tavily",
	envKey: "TAVILY_API_KEY",
	async search(query, limit, signal) {
		const key = requireKey(this.envKey, this.name);
		const max = clampLimit(limit, 20);
		const data = (await fetchJson(
			"https://api.tavily.com/search",
			{
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					api_key: key,
					query,
					max_results: max,
				}),
			},
			signal,
		)) as { results?: Array<Record<string, unknown>> };
		const results = Array.isArray(data?.results) ? data.results : [];
		const hits: SearchHit[] = [];
		for (const r of results) {
			const title = asString(r.title);
			const link = asString(r.url);
			if (!title || !link) continue;
			hits.push({
				title,
				url: link,
				snippet: asString(r.content),
				source: "tavily",
			});
		}
		return hits.slice(0, max);
	},
};

export const jinaProvider: SearchProvider = {
	name: "jina",
	envKey: "JINA_API_KEY",
	async search(query, limit, signal) {
		const key = requireKey(this.envKey, this.name);
		const max = clampLimit(limit, 20);
		const url = `https://s.jina.ai/${encodeURIComponent(query)}`;
		const data = (await fetchJson(
			url,
			{
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${key}`,
				},
			},
			signal,
		)) as { data?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
		const arr = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : [];
		const hits: SearchHit[] = [];
		for (const r of arr) {
			const title = asString(r.title);
			const link = asString(r.url);
			if (!title || !link) continue;
			hits.push({
				title,
				url: link,
				snippet: asString(r.description) ?? asString(r.content),
				source: "jina",
			});
		}
		return hits.slice(0, max);
	},
};

const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

export const perplexityProvider: SearchProvider = {
	name: "perplexity",
	envKey: "PERPLEXITY_API_KEY",
	async search(query, limit, signal) {
		const key = requireKey(this.envKey, this.name);
		const max = clampLimit(limit, 20);
		const data = (await fetchJson(
			"https://api.perplexity.ai/chat/completions",
			{
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bearer ${key}`,
				},
				body: JSON.stringify({
					model: "sonar",
					messages: [
						{
							role: "system",
							content: `search for: ${query}. Return a numbered markdown list of relevant links with a one-line description each. Format: 1. [title](url) — description`,
						},
						{ role: "user", content: query },
					],
				}),
			},
			signal,
		)) as { choices?: Array<{ message?: { content?: string } }> };
		const content = data?.choices?.[0]?.message?.content;
		if (typeof content !== "string" || content.length === 0) return [];
		const hits: SearchHit[] = [];
		const seen = new Set<string>();
		const lines = content.split(/\r?\n/);
		for (const line of lines) {
			LINK_RE.lastIndex = 0;
			const match = LINK_RE.exec(line);
			if (!match) continue;
			const title = match[1].trim();
			const url = match[2].trim();
			if (!title || !url || seen.has(url)) continue;
			seen.add(url);
			// Snippet: text after the link, stripped of leading punctuation.
			const after = line
				.slice(match.index + match[0].length)
				.replace(/^[\s\-—:.,]+/, "")
				.trim();
			hits.push({
				title,
				url,
				snippet: after.length > 0 ? after : undefined,
				source: "perplexity",
			});
			if (hits.length >= max) break;
		}
		return hits;
	},
};

export const exaProvider: SearchProvider = {
	name: "exa",
	envKey: "EXA_API_KEY",
	async search(query, limit, signal) {
		const key = requireKey(this.envKey, this.name);
		const max = clampLimit(limit, 20);
		const data = (await fetchJson(
			"https://api.exa.ai/search",
			{
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"x-api-key": key,
				},
				body: JSON.stringify({ query, numResults: max }),
			},
			signal,
		)) as { results?: Array<Record<string, unknown>> };
		const results = Array.isArray(data?.results) ? data.results : [];
		const hits: SearchHit[] = [];
		for (const r of results) {
			const title = asString(r.title);
			const link = asString(r.url);
			if (!title || !link) continue;
			hits.push({
				title,
				url: link,
				snippet: asString(r.text) ?? asString(r.snippet),
				source: "exa",
			});
		}
		return hits.slice(0, max);
	},
};

export const ALL_PROVIDERS: Record<string, SearchProvider> = {
	brave: braveProvider,
	tavily: tavilyProvider,
	jina: jinaProvider,
	perplexity: perplexityProvider,
	exa: exaProvider,
};

/** Return providers that currently have their env var present. */
export function availableProviders(order: SearchProvider[]): SearchProvider[] {
	return order.filter((p) => {
		const v = process.env[p.envKey];
		return typeof v === "string" && v.length > 0;
	});
}
