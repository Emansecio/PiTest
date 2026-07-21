/**
 * `recall_history` tool — BM25-search the conversation window that was compacted
 * away. The post-compaction model recovers a fact (file path, error, decision)
 * it would otherwise hallucinate. Mirrors `recall_tool_output` (deferred tool
 * outputs), generalized to discarded conversation history.
 *
 * The discarded entries stay intact in the session JSONL; the tool reads the
 * live branch via the module-global source `AgentSession` publishes on boot.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	collectDiscardedEntries,
	getCurrentHistoryRecallSource,
	type HistoryHit,
	searchDiscardedHistory,
} from "../history-recall.ts";
import { renderToolOutput, str } from "./render-utils.ts";
import { withOutputCap, wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { RECALL_OUTPUT_CAP_BYTES } from "./truncate.ts";

const recallHistorySchema = Type.Object(
	{
		query: Type.String({ description: "Natural-language search over the compacted-away conversation window." }),
		limit: Type.Optional(Type.Number({ description: "Max hits to return (default 5)." })),
	},
	{ additionalProperties: false },
);

export type RecallHistoryInput = Static<typeof recallHistorySchema>;

export interface RecallHistoryDetails {
	hits: number;
}

const DEFAULT_LIMIT = 5;

function formatHits(hits: HistoryHit[]): string {
	const lines: string[] = [];
	for (const hit of hits) {
		lines.push(`--- ${hit.entryId} · ${hit.role} · ${hit.timestamp} (score ${hit.score.toFixed(2)}) ---`);
		lines.push(hit.snippet);
	}
	return lines.join("\n");
}

export function createRecallHistoryDefinition(
	_cwd: string,
): ToolDefinition<typeof recallHistorySchema, RecallHistoryDetails> {
	const definition: ToolDefinition<typeof recallHistorySchema, RecallHistoryDetails> = {
		name: "recall_history",
		label: "recall_history",
		description:
			"Search the conversation history that was removed during context compaction. Use it to recover a specific fact (file path, error message, prior decision) you remember mentioning earlier instead of restating it from memory.",
		promptSnippet: "Recover a fact from the compacted-away conversation by keyword search",
		activity: "navigation",
		parameters: recallHistorySchema,
		async execute(_toolCallId, input: RecallHistoryInput) {
			const source = getCurrentHistoryRecallSource();
			if (!source) {
				return {
					content: [{ type: "text" as const, text: "History recall is unavailable in this context." }],
					details: { hits: 0 },
					isError: true,
				};
			}
			const branch = source();
			const discarded = collectDiscardedEntries(branch);
			if (discarded.length === 0) {
				return {
					content: [{ type: "text" as const, text: "No compacted history in this session." }],
					details: { hits: 0 },
				};
			}
			const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT;
			const hits = searchDiscardedHistory(discarded, input.query, limit);
			if (hits.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No matches in the compacted history for: ${input.query}`,
						},
					],
					details: { hits: 0 },
				};
			}
			return {
				content: [{ type: "text" as const, text: formatHits(hits) }],
				details: { hits: hits.length },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const query = str(args?.query);
			const display = query ? theme.fg("accent", query) : "...";
			text.setText(`${theme.fg("toolTitle", theme.bold("recall_history"))} ${display}`);
			return text;
		},
		renderResult: renderToolOutput,
	};
	// Same dedicated cap + head+tail mode as recall_tool_output: recalled history
	// can be large, and the tail (error/result/decision) is the decisive part.
	return withOutputCap(definition, { maxBytes: RECALL_OUTPUT_CAP_BYTES, mode: "headTail" });
}

export function createRecallHistoryTool(_cwd: string): AgentTool<typeof recallHistorySchema> {
	return wrapToolDefinition(createRecallHistoryDefinition(_cwd));
}
