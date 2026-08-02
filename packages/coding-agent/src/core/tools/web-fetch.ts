/**
 * `web_fetch` tool — dereference an arbitrary URL and return it as markdown.
 *
 * Read-only by construction: it performs a GET, converts, and returns text. It
 * never writes, never executes, and is classified `sideEffect: "none"` so plan
 * and ask (both read-only stances) can use it.
 *
 * Two things are worth knowing before touching this file:
 *  - the SSRF guard (`web-search/url-guard.ts`) runs before the first request
 *    AND on every redirect hop, and a guard rejection never falls back to the
 *    third-party scraper;
 *  - output is capped at {@link WEB_FETCH_MAX_CHARS} per call and paginated via
 *    `start_index`, so a large document is read in successive calls instead of
 *    detonating the context in one.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { sliceSafe, truncateWithEllipsis } from "../../utils/surrogate.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { type FetchedPage, type FetchPageSource, fetchPage } from "../web-search/page-fetch.ts";
import type { DnsResolver } from "../web-search/url-guard.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

/**
 * Per-call output ceiling (~24KB). Chosen to sit just under the point where a
 * single page starts to dominate a turn's context, while still returning most
 * documentation pages whole in one call.
 */
export const WEB_FETCH_MAX_CHARS = 24_000;

const webFetchSchema = Type.Object(
	{
		url: Type.String({
			description: "Absolute http(s) URL to fetch. Credentials in the URL and non-public addresses are rejected.",
		}),
		start_index: Type.Optional(
			Type.Number({
				description:
					"Character offset into the converted document. Default 0. Use the value reported at the end of a truncated result to page through a long document.",
				minimum: 0,
			}),
		),
	},
	{ additionalProperties: false },
);

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	url: string;
	status: number;
	contentType: string;
	source: FetchPageSource | "none";
	title?: string;
	totalChars: number;
	startIndex: number;
	/** Offset to pass as `start_index` for the next page; absent when the document ended. */
	nextStartIndex?: number;
}

export interface WebFetchToolOptions {
	/** Injectable fetch (tests, proxies). Defaults to the global `fetch`. */
	fetchImpl?: typeof fetch;
	/** Injectable DNS resolver for the SSRF guard. Defaults to `dns.lookup`. */
	resolve?: DnsResolver;
	/** Injectable environment (kill-switch + API key lookup). Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Render the page into the tool's text output: a two-line dense header, the
 * body slice, and — when the document continues — the offset to resume from.
 * Exported for tests.
 */
export function formatPage(
	page: FetchedPage,
	startIndex: number,
): { text: string; startIndex: number; endIndex: number; nextStartIndex?: number } {
	const total = page.body.length;
	const start = Math.min(Math.max(0, Math.floor(startIndex)), total);
	const slice = sliceSafe(page.body, start, start + WEB_FETCH_MAX_CHARS);
	const end = start + slice.length;
	const next = end < total ? end : undefined;

	const headline = page.title ? `${page.title} · ${page.url}` : page.url;
	const meta = [`${page.status}`, page.contentType || "(no content-type)", page.source];
	if (start > 0 || next !== undefined) meta.push(`chars ${start}-${end}/${total}`);

	const parts = [headline, meta.join(" · "), ""];
	if (total === 0) {
		parts.push("(empty document)");
	} else if (slice.length === 0) {
		parts.push(`(start_index ${start} is at or past the end of the ${total}-char document)`);
	} else {
		parts.push(slice);
	}
	if (next !== undefined) {
		parts.push("", `[truncated at ${WEB_FETCH_MAX_CHARS} chars] continue with start_index=${next}`);
	}
	return { text: parts.join("\n"), startIndex: start, endIndex: end, nextStartIndex: next };
}

export function createWebFetchToolDefinition(
	_cwd: string,
	options?: WebFetchToolOptions,
): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	return {
		name: "web_fetch",
		label: "web_fetch",
		description:
			"Fetch a URL and return its content as markdown. HTML is converted, text and JSON are returned raw; PDFs and binaries are not supported. Output is capped per call — page through long documents with start_index.",
		promptSnippet: "Fetch a URL and read it as markdown",
		promptGuidelines: [
			"Use when you already have a specific URL; use `web_search` when you still need to find one.",
			"Read the whole document: when the result says it was truncated, call again with the reported `start_index`.",
			"Non-public targets (localhost, LAN, link-local/cloud-metadata addresses) are refused by design — do not try to work around it.",
		],
		parameters: webFetchSchema,
		sideEffect: "none",
		async execute(_toolCallId, input: WebFetchToolInput, signal) {
			// `isError: true` is what the execution pipeline / TUI read to treat a
			// result as a failure (mirrors web_search); without it a refusal looks
			// like successfully-fetched empty content and invites a retry loop.
			const fail = (text: string, details?: Partial<WebFetchToolDetails>) => ({
				content: [{ type: "text" as const, text }],
				isError: true as const,
				details: {
					url: input.url ?? "",
					status: 0,
					contentType: "",
					source: "none" as const,
					totalChars: 0,
					startIndex: 0,
					...details,
				},
			});

			const url = typeof input.url === "string" ? input.url.trim() : "";
			if (!url) return fail("web_fetch error: empty url");

			let page: FetchedPage;
			try {
				page = await fetchPage(
					url,
					{ fetchImpl: options?.fetchImpl, resolve: options?.resolve, env: options?.env },
					signal,
				);
			} catch (err) {
				return fail(`web_fetch error: ${(err as Error).message}`);
			}

			if (page.kind === "unsupported") {
				return fail(`web_fetch: ${page.body}`, {
					url: page.url,
					status: page.status,
					contentType: page.contentType,
					source: page.source,
				});
			}

			const rendered = formatPage(page, input.start_index ?? 0);
			return {
				content: [{ type: "text" as const, text: rendered.text }],
				details: {
					url: page.url,
					status: page.status,
					contentType: page.contentType,
					source: page.source,
					title: page.title,
					totalChars: page.body.length,
					startIndex: rendered.startIndex,
					nextStartIndex: rendered.nextStartIndex,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const raw = str(args?.url);
			const display = raw && raw.length > 0 ? truncateWithEllipsis(raw, 80) : "(missing)";
			const offset = typeof args?.start_index === "number" && args.start_index > 0 ? ` @${args.start_index}` : "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("web_fetch"))} ${theme.fg("accent", display)}${theme.fg(
					"toolOutput",
					offset,
				)}`,
			);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			text.setText(output ? `${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

export function createWebFetchTool(cwd: string, options?: WebFetchToolOptions): AgentTool<typeof webFetchSchema> {
	return wrapToolDefinition(createWebFetchToolDefinition(cwd, options));
}
