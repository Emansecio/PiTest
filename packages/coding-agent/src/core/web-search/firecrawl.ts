/**
 * Firecrawl scrape provider — the fallback path behind `web_fetch`.
 *
 * The native fetcher is a plain HTTP GET plus a regex HTML→markdown pass. That
 * covers static pages, raw files and JSON APIs, but it loses to two common
 * cases: a bot wall (403/429/5xx from Cloudflare et al.) and a JS-rendered SPA
 * whose served HTML has no readable body. Firecrawl runs a real browser and
 * returns markdown, so it recovers both.
 *
 * The endpoint is usable WITHOUT credentials (validated live 2026-08-01: a
 * POST with no `Authorization` header returns `{"success":true,...}`), so this
 * is native/on-by-default in the project's usual shape: it just works, and
 * `PIT_NO_FIRECRAWL=1` is the kill-switch. `FIRECRAWL_API_KEY`, when present,
 * is sent as a bearer token to get the caller's own quota/limits.
 *
 * The caller is responsible for running the SSRF guard BEFORE calling in here:
 * a third party must never be handed an internal URL to dereference on our
 * behalf. `fetchPage` guards first and only ever passes the guarded URL along.
 */

import { isTruthyEnvFlag } from "../../utils/env-flags.ts";

export const FIRECRAWL_SCRAPE_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

/** Firecrawl drives a headless browser, so it needs more headroom than the native GET. */
export const FIRECRAWL_TIMEOUT_MS = 30_000;

export interface FirecrawlOptions {
	fetchImpl?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

export interface FirecrawlScrapeResult {
	markdown: string;
	title?: string;
	/** Upstream status Firecrawl saw for the page (not the Firecrawl API status). */
	status?: number;
	sourceUrl?: string;
}

/** Whether the Firecrawl fallback is active. Default ON; `PIT_NO_FIRECRAWL=1` disables it. */
export function isFirecrawlEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !isTruthyEnvFlag(env.PIT_NO_FIRECRAWL);
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Scrape one URL through Firecrawl and return its markdown. Throws on a
 * transport failure, a non-2xx API response, or a payload without markdown —
 * the caller decides whether that means "give up" or "report the native error".
 */
export async function firecrawlScrape(url: string, options: FirecrawlOptions = {}): Promise<FirecrawlScrapeResult> {
	const env = options.env ?? process.env;
	const doFetch = options.fetchImpl ?? fetch;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("firecrawl timeout")), FIRECRAWL_TIMEOUT_MS);
	const onAbort = () => controller.abort((options.signal as AbortSignal).reason);
	if (options.signal) {
		if (options.signal.aborted) controller.abort(options.signal.reason);
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json",
		"User-Agent": "pit-coding-agent/1.0 (+web_fetch)",
	};
	const apiKey = env.FIRECRAWL_API_KEY;
	if (apiKey && apiKey.length > 0) headers.Authorization = `Bearer ${apiKey}`;

	try {
		const res = await doFetch(FIRECRAWL_SCRAPE_ENDPOINT, {
			method: "POST",
			headers,
			body: JSON.stringify({ url, formats: ["markdown"] }),
			signal: controller.signal,
		});
		if (!res.ok) {
			throw new Error(`firecrawl HTTP ${res.status} ${res.statusText}`);
		}
		const payload = (await res.json()) as {
			success?: boolean;
			error?: string;
			data?: { markdown?: unknown; metadata?: Record<string, unknown> };
		};
		if (payload?.success !== true) {
			throw new Error(`firecrawl returned success=false${payload?.error ? `: ${payload.error}` : ""}`);
		}
		const markdown = payload.data?.markdown;
		if (typeof markdown !== "string" || markdown.trim().length === 0) {
			throw new Error("firecrawl returned no markdown");
		}
		const metadata = payload.data?.metadata;
		const statusCode = metadata?.statusCode;
		return {
			markdown,
			title: readString(metadata, "title"),
			status: typeof statusCode === "number" ? statusCode : undefined,
			sourceUrl: readString(metadata, "sourceURL") ?? readString(metadata, "url"),
		};
	} finally {
		clearTimeout(timer);
		if (options.signal) options.signal.removeEventListener("abort", onAbort);
	}
}
