/**
 * Search provider implementations for the `web_search` tool.
 *
 * Each provider exposes a small `search()` function that hits a vendor HTTP
 * API via `fetch` and returns normalized `SearchHit`s. Providers are bundled
 * by the chain runner; missing env keys make a provider skip silently in
 * auto mode but throw a clear error when the user selects them explicitly.
 */

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

async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
	const merged: RequestInit = { ...init, signal: signal ?? init.signal };
	const res = await fetch(url, merged);
	if (!res.ok) {
		const text = await res.text().catch(() => "");
		throw new Error(`HTTP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
	}
	return (await res.json()) as unknown;
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
