/**
 * `search_tool_bm25` tool — BM25-rank a hidden tool index and surface the best
 * matches. Pattern: model invokes search -> top-K candidates returned ->
 * optionally activate the top-1 so it joins the active tool surface.
 *
 * Saves prompt tokens by keeping specialized tools off the default catalog.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { truncateWithEllipsis } from "../../utils/surrogate.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentToolDiscoveryIndex, type ToolDiscoveryIndex } from "../tool-discovery.ts";
import { renderToolOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 15;
const ACTIVATION_SCORE_FLOOR = 0.1;

const searchToolBm25Schema = Type.Object(
	{
		query: Type.String({
			description: "Natural-language description of the capability you need. BM25 ranks hidden tools against this.",
		}),
		limit: Type.Optional(
			Type.Number({
				description: `Max results to return. Default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}.`,
			}),
		),
		activate_top: Type.Optional(
			Type.Boolean({
				description:
					"If true and the top result has a non-trivial score, activate it so it joins the active tool surface.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type SearchToolBm25Input = Static<typeof searchToolBm25Schema>;

export interface SearchToolBm25Details {
	matches: Array<{ name: string; score: number }>;
	activated?: string;
}

export interface SearchToolBm25Options {
	/** Inject an index for tests. Falls back to the module-level current index. */
	index?: ToolDiscoveryIndex;
}

function textResult(
	text: string,
	details: SearchToolBm25Details,
): { content: Array<{ type: "text"; text: string }>; details: SearchToolBm25Details } {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function createSearchToolBm25Definition(
	_cwd: string,
	options?: SearchToolBm25Options,
): ToolDefinition<typeof searchToolBm25Schema, SearchToolBm25Details> {
	return {
		name: "search_tool_bm25",
		activity: "navigation",
		label: "search_tool_bm25",
		description:
			"Retrieve specialized tools that are NOT in the default tool surface. BM25-search a hidden tool index and (optionally) activate the top match so it becomes callable. Use when you need a capability that does not appear in the active tool list. This retrieves specialized/hidden TOOLS by capability — it is NOT code search (use `grep`) nor memory search (use `recall`).",
		promptSnippet: "BM25-search hidden tools and optionally activate the top match",
		promptGuidelines: [
			"Call only when the active tool list lacks a needed capability — describe the capability, not a tool name.",
			"Set activate_top=true to immediately bring the best match into the active surface for follow-up calls.",
			"Skip if the active tools already cover the task; this is a fallback, not the first move.",
		],
		parameters: searchToolBm25Schema,
		async execute(_toolCallId, input: SearchToolBm25Input) {
			const index = options?.index ?? getCurrentToolDiscoveryIndex();
			const details: SearchToolBm25Details = { matches: [] };
			if (!index) {
				return textResult("No hidden tool index. All tools active by default.", details);
			}
			const rawLimit = typeof input.limit === "number" ? Math.floor(input.limit) : DEFAULT_LIMIT;
			const limit = Math.max(1, Math.min(MAX_LIMIT, rawLimit));
			const results = index.search(input.query, limit);
			details.matches = results.map((r) => ({ name: r.entry.name, score: r.score }));

			if (results.length === 0) {
				return textResult(`No hidden tool matches for query: "${input.query}".`, details);
			}

			const header = `Top ${results.length} tool match${results.length === 1 ? "" : "es"} for query: "${input.query}"`;
			const lines = results.map(
				(r, i) =>
					`${i + 1}. ${r.entry.name} (score=${r.score.toFixed(2)})\n   ${r.snippet.replace(/\s+/g, " ").trim()}`,
			);
			let body = `${header}\n\n${lines.join("\n")}`;

			if (input.activate_top) {
				const top = results[0];
				if (top && top.score > ACTIVATION_SCORE_FLOOR) {
					const activated = index.activate(top.entry.name);
					if (activated) {
						details.activated = top.entry.name;
						body += `\n\nActivated: ${top.entry.name}. Available for use in subsequent calls.`;
					}
				}
			}

			return textResult(body, details);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const query = str(args?.query);
			const display = query ? theme.fg("accent", truncateWithEllipsis(query, 60)) : "...";
			text.setText(`${theme.fg("toolTitle", theme.bold("search_tool_bm25"))} ${display}`);
			return text;
		},
		renderResult: renderToolOutput,
	};
}

export function createSearchToolBm25Tool(
	cwd: string,
	options?: SearchToolBm25Options,
): AgentTool<typeof searchToolBm25Schema> {
	return wrapToolDefinition(createSearchToolBm25Definition(cwd, options));
}
