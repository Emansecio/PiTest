/**
 * `web_search` tool — queries one of several ranked search providers (Brave,
 * Tavily, Jina, Perplexity, Exa), optionally chained with auto-fallback, and
 * can fetch + extract clean markdown from each hit's URL.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { sliceSafe } from "../../utils/surrogate.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	ALL_PROVIDERS,
	autoSearchChain,
	type ChainOutcome,
	extractFromUrl,
	getDefaultProviderChain,
	type SearchHit,
	type SearchProvider,
} from "../web-search/index.ts";
import { isJsonCrushEnabled, maybeCrushJsonOutput } from "./json-crush.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { collapseRepeatedLines } from "./truncate.ts";

const PROVIDER_NAMES = ["auto", "brave", "tavily", "jina", "perplexity", "exa"] as const;
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const EXTRACT_BODY_CAP = 2048;

const webSearchSchema = Type.Object(
	{
		query: Type.String({ description: "Free-text search query." }),
		limit: Type.Optional(
			Type.Number({
				description: `Max results to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
				minimum: 1,
				maximum: MAX_LIMIT,
			}),
		),
		provider: Type.Optional(
			Type.Enum(PROVIDER_NAMES, {
				description: 'Provider id. "auto" walks the configured chain in priority order.',
			}),
		),
		extract: Type.Optional(
			Type.Boolean({
				description: "When true, fetch each result URL and inline a markdown extract (capped per result).",
			}),
		),
	},
	{ additionalProperties: false },
);

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchToolDetails {
	provider: string;
	hits: number;
	extracted?: number;
	attempts?: Array<{ provider: string; error?: string; count: number }>;
}

export interface WebSearchToolOptions {
	defaultProvider?: string;
	providers?: SearchProvider[];
}

function resolveProviders(
	input: WebSearchToolInput,
	options: WebSearchToolOptions | undefined,
): { providers: SearchProvider[]; selected: string } {
	const explicit = input.provider ?? options?.defaultProvider ?? "auto";
	if (explicit === "auto") {
		const chain = options?.providers ?? getDefaultProviderChain();
		return { providers: chain, selected: "auto" };
	}
	const p = ALL_PROVIDERS[explicit];
	if (!p) {
		throw new Error(`unknown provider: ${explicit}`);
	}
	return { providers: [p], selected: explicit };
}

/**
 * Fraction of the cap below which a sentence-boundary cut degenerates (the last
 * boundary sits too early, discarding most of the budget); under it we fall
 * back to the raw char cut so a punctuation-free wall of text still yields a
 * usefully sized excerpt.
 */
const EXTRACT_BOUNDARY_FLOOR = 0.6;

/**
 * Last sentence/line boundary in `window`, as an exclusive end index (0 when
 * none). A `.`/`!`/`?` only counts when followed by whitespace (or the window
 * end) so decimals and dotted identifiers ("3.14", "pkg.name") don't cut
 * mid-token; a newline always counts (markdown extracts are line-structured).
 */
function lastSentenceBoundary(window: string): number {
	for (let i = window.length - 1; i >= 0; i--) {
		const c = window.charCodeAt(i);
		if (c === 10 /* \n */) return i + 1;
		if (c === 46 /* . */ || c === 33 /* ! */ || c === 63 /* ? */) {
			const next = i + 1 < window.length ? window.charCodeAt(i + 1) : 32;
			if (next === 32 || next === 10 || next === 9 || next === 13) return i + 1;
		}
	}
	return 0;
}

/**
 * Cap an extract body without leaving a mid-sentence stump. Upgrade-only
 * (mirrors json-crush's design contract): text at or under the cap is returned
 * byte-identical. Over the cap, in order:
 *  1. JSON/NDJSON payloads (a raw API endpoint behind the URL) are structurally
 *     crushed to schema + samples via the shared json-crush machinery.
 *  2. Runs of identical lines are collapsed (HTML nav/footer/menu noise) —
 *     lossless, and sometimes enough to fit the cap on its own.
 *  3. The cut lands on the last sentence/line boundary before the cap, floored
 *     at 60% of it; below the floor the old raw char cut applies unchanged.
 *
 * Exported for tests.
 */
export function capExtractBody(text: string, max: number): string {
	if (text.length <= max) return text;
	const crushed = maybeCrushJsonOutput({
		text,
		shouldAttempt: isJsonCrushEnabled(),
		recoveryHint: "Fetch the URL directly for the full payload.",
		targetChars: max,
	});
	if (crushed !== undefined) return crushed;
	const collapsed = collapseRepeatedLines(text);
	if (collapsed.length <= max) return collapsed;
	const window = sliceSafe(collapsed, 0, max - 3);
	const boundary = lastSentenceBoundary(window);
	if (boundary >= Math.floor(max * EXTRACT_BOUNDARY_FLOOR)) {
		return `${window.slice(0, boundary).trimEnd()}...`;
	}
	return `${window}...`;
}

// Cut a string to at most `max` UTF-16 code units without splitting a surrogate
// pair: if the cut would land between a high and low surrogate, drop the trailing
// lone high surrogate so the caller can safely append an ellipsis.
function clampQuery(text: string, max: number): string {
	const cut = text.slice(0, max);
	const last = cut.charCodeAt(cut.length - 1);
	if (last >= 0xd800 && last <= 0xdbff) return cut.slice(0, -1);
	return cut;
}

function formatHits(hits: SearchHit[], outcome: ChainOutcome, extracts: Map<string, string>): string {
	if (hits.length === 0) return "No results.";
	const lines: string[] = [];
	lines.push(`Results from ${outcome.usedProvider} (${hits.length}):`);
	lines.push("");
	let i = 1;
	for (const hit of hits) {
		lines.push(`${i}. ${hit.title}`);
		lines.push(`   ${hit.url}`);
		if (hit.snippet) {
			lines.push(`   ${hit.snippet.replace(/\s+/g, " ").trim()}`);
		}
		const body = extracts.get(hit.url);
		if (body) {
			lines.push("");
			lines.push("   --- extract ---");
			for (const line of capExtractBody(body, EXTRACT_BODY_CAP).split(/\r?\n/)) {
				lines.push(`   ${line}`);
			}
			lines.push("   --- end ---");
		}
		lines.push("");
		i += 1;
	}
	return lines.join("\n").trimEnd();
}

export function createWebSearchToolDefinition(
	_cwd: string,
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the live web for current information through one of several ranked providers. Set extract=true to also fetch and inline a clean markdown excerpt of each result.",
		promptSnippet: "Search the web for current information",
		promptGuidelines: [
			"Use when local context lacks current or external information (docs, releases, news, API specs).",
			'Prefer provider="auto" so the chain picks whichever provider is configured.',
			"Set extract=true only when you need page content; it costs extra network round-trips.",
			"Keep limit small (default 8, max 20) — results are markdown lines, not a database query.",
		],
		parameters: webSearchSchema,
		async execute(_toolCallId, input: WebSearchToolInput, signal) {
			// `isError: true` is the flag the execution pipeline / TUI read to treat a
			// result as a failure (mirrors plan/todo). Without it every error below
			// looked like a successful empty search to retry / loop-detection.
			const fail = (text: string, details: WebSearchToolDetails) => ({
				content: [{ type: "text" as const, text }],
				isError: true as const,
				details,
			});

			const query = input.query.trim();
			if (!query) {
				return fail("empty query", { provider: "none", hits: 0 });
			}
			const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)));

			let providers: SearchProvider[];
			let selected: string;
			try {
				const resolved = resolveProviders(input, options);
				providers = resolved.providers;
				selected = resolved.selected;
			} catch (err) {
				return fail(`web_search error: ${(err as Error).message}`, { provider: "none", hits: 0 });
			}

			if (providers.length === 0) {
				return fail(
					"web_search error: no providers configured. Set one of BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, JINA_API_KEY, PERPLEXITY_API_KEY.",
					{ provider: "none", hits: 0 },
				);
			}

			let outcome: ChainOutcome;
			try {
				outcome = await autoSearchChain(query, limit, providers, signal);
			} catch (err) {
				return fail(`web_search error: ${(err as Error).message}`, { provider: selected, hits: 0 });
			}

			const extracts = new Map<string, string>();
			let extracted = 0;
			if (input.extract === true && outcome.hits.length > 0) {
				const results = await Promise.allSettled(outcome.hits.map((hit) => extractFromUrl(hit.url, signal)));
				results.forEach((r, idx) => {
					if (r.status === "fulfilled") {
						extracts.set(outcome.hits[idx].url, r.value.markdown);
						extracted += 1;
					}
				});
			}

			const text = formatHits(outcome.hits, outcome, extracts);
			return {
				content: [{ type: "text" as const, text }],
				details: {
					provider: outcome.usedProvider,
					hits: outcome.hits.length,
					extracted: input.extract === true ? extracted : undefined,
					attempts: outcome.attempts,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const q = str(args?.query);
			const display = q && q.length > 0 ? (q.length > 80 ? `${clampQuery(q, 79)}…` : q) : "(missing)";
			const provider = str(args?.provider);
			const providerDisplay = provider && provider !== "auto" ? ` [${provider}]` : "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("accent", display)}${theme.fg(
					"toolOutput",
					providerDisplay,
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

export function createWebSearchTool(cwd: string, options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(cwd, options));
}
