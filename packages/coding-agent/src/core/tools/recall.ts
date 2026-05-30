/**
 * `recall` tool — searches the project's hindsight memory bank for entries
 * relevant to a query string. Returns ranked results formatted for the model.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	getCurrentHindsightBank,
	type HindsightBank,
	type HindsightKind,
	type HindsightSearchResult,
} from "../hindsight/index.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const BODY_TRUNCATE = 400;

const recallSchema = Type.Object(
	{
		query: Type.String({ description: "Search query. Free-text; matches body, subject, and tags." }),
		limit: Type.Optional(Type.Number({ description: "Max results to return. Default 10." })),
		kinds: Type.Optional(
			Type.Array(Type.String(), {
				description: "Filter by entry kinds: fact, decision, pattern, session-summary.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type RecallToolInput = Static<typeof recallSchema>;

export interface RecallToolDetails {
	matchCount: number;
}

export interface RecallToolOptions {
	bank?: HindsightBank;
}

const VALID_KINDS: ReadonlySet<HindsightKind> = new Set(["fact", "decision", "pattern", "session-summary"]);

function coerceKinds(raw: string[] | undefined): HindsightKind[] | undefined {
	if (!raw || raw.length === 0) return undefined;
	const out: HindsightKind[] = [];
	for (const candidate of raw) {
		if (VALID_KINDS.has(candidate as HindsightKind)) {
			out.push(candidate as HindsightKind);
		}
	}
	return out.length > 0 ? out : undefined;
}

function formatResult(result: HindsightSearchResult): string {
	const { entry } = result;
	const subject = entry.subject ? ` (subject "${entry.subject}")` : "";
	const tags = entry.tags && entry.tags.length > 0 ? ` tags: ${entry.tags.join(", ")}` : "";
	let body = entry.body;
	let truncatedNote = "";
	if (body.length > BODY_TRUNCATE) {
		body = `${body.slice(0, BODY_TRUNCATE).trimEnd()}…`;
		truncatedNote = `\n(see full entry: ${entry.id})`;
	}
	return `## ${entry.kind}${subject} [id: ${entry.id}]${tags}\n${body}${truncatedNote}`;
}

export function createRecallToolDefinition(
	_cwd: string,
	options?: RecallToolOptions,
): ToolDefinition<typeof recallSchema, RecallToolDetails> {
	return {
		name: "recall",
		label: "recall",
		description:
			"Search the project's hindsight memory bank for relevant entries. Use this before doing redundant investigation — past sessions may have already established the answer.",
		promptSnippet: "Search project hindsight memory",
		promptGuidelines: [
			"Use recall before grepping the codebase if the question is about prior decisions, conventions, or gotchas — hindsight is faster.",
		],
		parameters: recallSchema,
		async execute(_toolCallId: string, input: RecallToolInput) {
			const bank = options?.bank ?? getCurrentHindsightBank();
			if (!bank) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Hindsight bank is not enabled for this session.",
						},
					],
					details: { matchCount: 0 },
					isError: true,
				};
			}

			const limit = typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 10;
			const kinds = coerceKinds(input.kinds);
			const results = bank.search({ query: input.query, limit, kinds });
			if (results.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No hindsight entries matched: ${input.query}`,
						},
					],
					details: { matchCount: 0 },
				};
			}
			const blocks = results.map(formatResult);
			const text = `Found ${results.length} hindsight entr${results.length === 1 ? "y" : "ies"} for "${input.query}":\n\n${blocks.join("\n\n---\n\n")}`;
			return {
				content: [{ type: "text" as const, text }],
				details: { matchCount: results.length },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const query = str(args?.query) || "(missing)";
			text.setText(`${theme.fg("toolTitle", theme.bold("recall"))} ${theme.fg("accent", query)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result as any, context.showImages).trim();
			text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

export function createRecallTool(cwd: string, options?: RecallToolOptions): AgentTool<typeof recallSchema> {
	return wrapToolDefinition(createRecallToolDefinition(cwd, options));
}
