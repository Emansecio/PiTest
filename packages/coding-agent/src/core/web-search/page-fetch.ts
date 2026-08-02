/**
 * The fetch pipeline behind the `web_fetch` tool: SSRF-guarded HTTP GET →
 * content-type dispatch → markdown, with an automatic Firecrawl fallback.
 *
 * Layout of a call:
 *  1. `assertUrlAllowed` on the URL the caller gave us. A rejection here is
 *     TERMINAL — it never falls back, because handing an internal URL to a
 *     third-party scraper is the exact thing the guard exists to prevent.
 *  2. Native GET with `redirect: "manual"`, following at most 5 hops and
 *     re-running the guard on every hop (a public host that 302s to
 *     169.254.169.254 is the classic bypass).
 *  3. Byte-capped read, then charset resolution (`Content-Type` header →
 *     `<meta charset>` prescan for HTML → UTF-8) and decode.
 *  4. Content-type dispatch: HTML → markdown, text/JSON → raw (capped), PDF and
 *     binary → an explicit "not supported" result rather than a wall of bytes.
 *  5. Fallback to Firecrawl when the native path is bot-walled (403/429/5xx),
 *     times out / errors at the transport layer, or returns HTML that converts
 *     to almost nothing (a JS-rendered SPA).
 *
 * Everything network-facing is injectable (`fetchImpl`, `resolve`, `env`) so
 * the test suite stays hermetic — the default suite performs no DNS and no
 * sockets.
 */

import { combineSignals, htmlToMarkdown, readCappedBytes } from "./extractors.ts";
import { firecrawlScrape, isFirecrawlEnabled } from "./firecrawl.ts";
import { assertUrlAllowed, type DnsResolver, UrlBlockedError } from "./url-guard.ts";

/** Wall-clock budget for one native GET (per hop). */
export const NATIVE_TIMEOUT_MS = 15_000;
/** Hard ceiling on the raw body read before conversion. Bounds memory and regex work. */
export const MAX_RAW_BYTES = 2 * 1024 * 1024;
/** Redirect hops followed manually (each one re-guarded). */
export const MAX_REDIRECTS = 5;

/**
 * JS-heavy heuristic: a page that shipped a real amount of HTML but converted
 * to almost no text is an app shell, not a document — worth a Firecrawl retry.
 */
const JS_HEAVY_MIN_HTML_CHARS = 2_000;
const JS_HEAVY_MAX_MARKDOWN_CHARS = 200;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * How far into the body we look for a `<meta>` charset declaration. The HTML
 * spec puts the prescan limit at 1024 bytes and real documents declare it in
 * the first few lines of `<head>`.
 */
const META_CHARSET_SNIFF_BYTES = 1024;

export type FetchPageSource = "native" | "firecrawl";

/** How the body should be read by the consumer (also drives the tool's error flag). */
export type FetchPageKind = "markdown" | "text" | "json" | "unsupported";

export interface FetchedPage {
	/** Final URL after redirects (or the Firecrawl-reported source URL). */
	url: string;
	status: number;
	contentType: string;
	title?: string;
	/** Markdown, raw text, or — for `kind: "unsupported"` — the explanation. */
	body: string;
	kind: FetchPageKind;
	source: FetchPageSource;
}

export interface FetchPageDeps {
	fetchImpl?: typeof fetch;
	resolve?: DnsResolver;
	env?: NodeJS.ProcessEnv;
}

/** A non-2xx native response. Carries the status so the fallback policy can read it. */
export class HttpStatusError extends Error {
	readonly status: number;
	readonly statusText: string;
	readonly url: string;

	constructor(status: number, statusText: string, url: string) {
		super(`HTTP ${status}${statusText ? ` ${statusText}` : ""} for ${url}`);
		this.name = "HttpStatusError";
		this.status = status;
		this.statusText = statusText;
		this.url = url;
	}
}

function mimeOf(contentType: string): string {
	return (contentType.split(";")[0] ?? "").trim().toLowerCase();
}

/** The `charset=` parameter of a `Content-Type` header, if it carries one. */
export function charsetFromContentType(contentType: string): string | undefined {
	for (const part of contentType.split(";").slice(1)) {
		const eq = part.indexOf("=");
		if (eq < 0) continue;
		if (part.slice(0, eq).trim().toLowerCase() !== "charset") continue;
		const value = part
			.slice(eq + 1)
			.trim()
			.replace(/^["']|["']$/g, "")
			.trim();
		if (value) return value;
	}
	return undefined;
}

/**
 * The charset declared by `<meta charset="...">` or by a `<meta
 * http-equiv="Content-Type" content="...; charset=...">`, looked for in the
 * first {@link META_CHARSET_SNIFF_BYTES} bytes. Both forms are found by the
 * same scan: what matters is a `charset=` inside a `<meta>` tag.
 *
 * The prescan itself is done in latin1, which is ASCII-transparent and never
 * throws — a document whose real encoding we do not know yet still yields
 * readable tag syntax.
 */
export function charsetFromMeta(bytes: Uint8Array): string | undefined {
	const head = bytes.subarray(0, META_CHARSET_SNIFF_BYTES);
	const text = new TextDecoder("latin1").decode(head);
	const match = text.match(/<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([a-z0-9_\-:.+]+)/i);
	const label = match?.[1];
	if (!label) return undefined;
	// Per the HTML prescan rules: a document that declared utf-16 in ASCII-
	// readable bytes cannot actually be utf-16, so treat it as utf-8.
	return /^utf-?16/i.test(label) ? "utf-8" : label;
}

/**
 * Decode a body with the given charset label, falling back to UTF-8 when the
 * label is unknown to the platform. Never throws and never rejects malformed
 * input: `fatal: false` substitutes U+FFFD, which also covers a multi-byte
 * character sliced in half by the {@link MAX_RAW_BYTES} cap.
 */
export function decodeBody(bytes: Uint8Array, charset: string | undefined): string {
	if (charset) {
		try {
			return new TextDecoder(charset, { fatal: false }).decode(bytes);
		} catch {
			// Unknown/unsupported label — fall through to UTF-8.
		}
	}
	return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function extractTitle(html: string): string | undefined {
	const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	if (!match) return undefined;
	// Decoded via the shared entity decoder inside htmlToMarkdown's helpers; do
	// it here through a minimal strip so a `<title>` with inline markup is clean.
	const text = match[1]
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return text.length > 0 ? text : undefined;
}

/** Convert an HTML document to markdown, scoped to `<body>` when the document has one. */
export function htmlDocumentToMarkdown(html: string): string {
	const body = html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
	return htmlToMarkdown(body);
}

/**
 * Whether a converted HTML page looks like an empty app shell (JS-rendered):
 * a real payload of HTML that yielded almost no readable text.
 */
export function looksJsHeavy(rawHtmlLength: number, markdown: string): boolean {
	return rawHtmlLength >= JS_HEAVY_MIN_HTML_CHARS && markdown.trim().length < JS_HEAVY_MAX_MARKDOWN_CHARS;
}

/**
 * One native GET, following redirects manually and re-guarding each hop.
 * Throws `HttpStatusError` on non-2xx and `UrlBlockedError` on a hop the guard
 * rejects. Also reports the raw body length so the caller can apply the
 * JS-heavy heuristic without keeping the document alive.
 */
async function nativeFetch(
	startUrl: URL,
	deps: FetchPageDeps,
	signal?: AbortSignal,
): Promise<{ page: FetchedPage; rawLength: number }> {
	const doFetch = deps.fetchImpl ?? fetch;
	let current = startUrl;

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		// Hop 0 was guarded by the caller; every subsequent Location is fresh input.
		if (hop > 0) current = await assertUrlAllowed(current, { resolve: deps.resolve });

		const { signal: combined, cancel } = combineSignals(NATIVE_TIMEOUT_MS, signal, "web_fetch timeout");
		let res: Response;
		try {
			res = await doFetch(current.toString(), {
				signal: combined,
				redirect: "manual",
				headers: {
					"User-Agent": "pit-coding-agent/1.0 (+web_fetch)",
					Accept: "text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.5",
				},
			});
		} finally {
			cancel();
		}

		if (REDIRECT_STATUSES.has(res.status)) {
			const location = res.headers.get("location");
			await res.body?.cancel().catch(() => {});
			if (!location) throw new HttpStatusError(res.status, res.statusText, current.toString());
			current = new URL(location, current);
			continue;
		}

		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			throw new HttpStatusError(res.status, res.statusText, current.toString());
		}

		const contentType = res.headers.get("content-type") ?? "";
		const mime = mimeOf(contentType);
		const finalUrl = current.toString();

		if (mime === "application/pdf") {
			await res.body?.cancel().catch(() => {});
			return {
				page: {
					url: finalUrl,
					status: res.status,
					contentType,
					body: "PDF documents are not supported by web_fetch. Download the file first, then open the local path with `read` (which converts PDFs to markdown).",
					kind: "unsupported",
					source: "native",
				},
				rawLength: 0,
			};
		}

		// Read bytes, THEN decide the charset: for HTML the declaration may live
		// in the bytes themselves (`<meta charset>`), so decoding can only happen
		// once the head of the document is in hand.
		const bytes = await readCappedBytes(res, MAX_RAW_BYTES);
		const headerCharset = charsetFromContentType(contentType);
		// A blank mime is sniffed as HTML just below, so it gets the meta prescan
		// too; on non-HTML bytes the pattern simply does not match.
		const mayBeHtml = mime === "text/html" || mime === "application/xhtml+xml" || mime === "";
		const text = decodeBody(bytes, headerCharset ?? (mayBeHtml ? charsetFromMeta(bytes) : undefined));
		const rawLength = text.length;

		const isHtml =
			mime === "text/html" || mime === "application/xhtml+xml" || (mime === "" && text.trimStart().startsWith("<"));
		if (isHtml) {
			return {
				page: {
					url: finalUrl,
					status: res.status,
					contentType: contentType || "text/html",
					title: extractTitle(text),
					body: htmlDocumentToMarkdown(text),
					kind: "markdown",
					source: "native",
				},
				rawLength,
			};
		}
		if (mime === "application/json" || mime.endsWith("+json")) {
			return {
				page: { url: finalUrl, status: res.status, contentType, body: text, kind: "json", source: "native" },
				rawLength,
			};
		}
		if (mime.startsWith("text/") || mime === "") {
			return {
				page: { url: finalUrl, status: res.status, contentType, body: text, kind: "text", source: "native" },
				rawLength,
			};
		}

		return {
			page: {
				url: finalUrl,
				status: res.status,
				contentType,
				body: `Content type "${mime}" is binary and is not supported by web_fetch — only HTML, text/*, and JSON can be read as text.`,
				kind: "unsupported",
				source: "native",
			},
			rawLength,
		};
	}

	throw new Error(`too many redirects (>${MAX_REDIRECTS}) starting at ${startUrl.toString()}`);
}

/** Whether a native failure is worth retrying through Firecrawl. */
function shouldFallback(err: unknown): boolean {
	if (err instanceof UrlBlockedError) return false;
	if (err instanceof HttpStatusError) {
		return err.status === 403 || err.status === 429 || err.status >= 500;
	}
	// Transport-layer failure (DNS/TCP/TLS) or our own timeout — a real browser
	// on someone else's network may well succeed.
	return true;
}

async function fromFirecrawl(url: string, deps: FetchPageDeps, signal?: AbortSignal): Promise<FetchedPage> {
	const result = await firecrawlScrape(url, { fetchImpl: deps.fetchImpl, env: deps.env, signal });
	return {
		url: result.sourceUrl ?? url,
		status: result.status ?? 200,
		contentType: "text/markdown",
		title: result.title,
		body: result.markdown,
		kind: "markdown",
		source: "firecrawl",
	};
}

/**
 * Fetch one URL and return it as readable text. See the module docblock for the
 * ordering guarantees (guard first, guard every hop, fallback last).
 */
export async function fetchPage(rawUrl: string, deps: FetchPageDeps = {}, signal?: AbortSignal): Promise<FetchedPage> {
	const env = deps.env ?? process.env;
	// Terminal on rejection — deliberately outside the try below so a blocked URL
	// can never leak into the Firecrawl fallback.
	const url = await assertUrlAllowed(rawUrl, { resolve: deps.resolve });
	const firecrawlAvailable = isFirecrawlEnabled(env);

	let nativeError: unknown;
	try {
		const { page, rawLength } = await nativeFetch(url, deps, signal);
		const jsHeavy = page.kind === "markdown" && looksJsHeavy(rawLength, page.body);
		if (!jsHeavy || !firecrawlAvailable) return page;
		// The page parsed, it just looks empty. Firecrawl is a best-effort upgrade
		// here: if it fails or returns even less, keep the native result.
		try {
			const scraped = await fromFirecrawl(url.toString(), deps, signal);
			return scraped.body.trim().length > page.body.trim().length ? scraped : page;
		} catch {
			return page;
		}
	} catch (err) {
		if (err instanceof UrlBlockedError) throw err;
		if (signal?.aborted) throw err;
		nativeError = err;
		if (!firecrawlAvailable || !shouldFallback(err)) throw err;
	}

	try {
		return await fromFirecrawl(url.toString(), deps, signal);
	} catch (fallbackErr) {
		// Report the ORIGINAL failure — that is the one describing the target site.
		const primary = nativeError instanceof Error ? nativeError.message : String(nativeError);
		throw new Error(`${primary} (firecrawl fallback also failed: ${(fallbackErr as Error).message})`);
	}
}
