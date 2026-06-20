/**
 * `web_search` tool — queries one of several ranked search providers (Brave,
 * Tavily, Jina, Perplexity, Exa), optionally chained with auto-fallback, and
 * can fetch + extract clean markdown from each hit's URL.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
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
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

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

function capBody(text: string, max: number): string {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 3)}...`;
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
			for (const line of capBody(body, EXTRACT_BODY_CAP).split(/\r?\n/)) {
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
			const query = input.query.trim();
			if (!query) {
				return {
					content: [{ type: "text" as const, text: "empty query" }],
					details: { provider: "none", hits: 0 },
				};
			}
			const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(input.limit ?? DEFAULT_LIMIT)));

			let providers: SearchProvider[];
			let selected: string;
			try {
				const resolved = resolveProviders(input, options);
				providers = resolved.providers;
				selected = resolved.selected;
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `web_search error: ${(err as Error).message}` }],
					details: { provider: "none", hits: 0 },
				};
			}

			if (providers.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "web_search error: no providers configured. Set one of BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, JINA_API_KEY, PERPLEXITY_API_KEY.",
						},
					],
					details: { provider: "none", hits: 0 },
				};
			}

			let outcome: ChainOutcome;
			try {
				outcome = await autoSearchChain(query, limit, providers, signal);
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `web_search error: ${(err as Error).message}` }],
					details: { provider: selected, hits: 0 },
				};
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
