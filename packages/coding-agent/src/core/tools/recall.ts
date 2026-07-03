/**
 * `recall` tool — searches the project's hindsight memory bank for entries
 * relevant to a query string. Returns ranked results formatted for the model.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { sliceSafe } from "../../utils/surrogate.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	getCurrentHindsightBank,
	type HindsightBank,
	type HindsightKind,
	type HindsightSearchResult,
} from "../hindsight/index.ts";
import { HINDSIGHT_BANK_ABSENT_MESSAGE, HINDSIGHT_KINDS, resolveScope } from "./hindsight-tool-shared.ts";
import { renderToolOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const BODY_TRUNCATE = 400;
const RECALL_MAX_LIMIT = 50;

const recallSchema = Type.Object(
	{
		query: Type.String({ description: "Search query. Free-text; matches body, subject, and tags." }),
		limit: Type.Optional(
			Type.Number({ description: `Max results to return. Default 10, capped at ${RECALL_MAX_LIMIT}.` }),
		),
		kinds: Type.Optional(
			Type.Array(Type.Enum(HINDSIGHT_KINDS), {
				description: `Filter by entry kinds: ${HINDSIGHT_KINDS.join(", ")}. Unknown kinds are ignored (noted in the result text).`,
			}),
		),
		scope: Type.Optional(
			Type.String({
				description:
					"Override search scope: 'own' (this agent's scope + global, default), 'global' (global only), 'all' (every scope), or a specific agent-type name.",
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
	/** Bound agent scope; drives default scope filtering for this instance. */
	agentScope?: string;
}

function coerceKinds(raw: string[] | undefined): { kinds: HindsightKind[] | undefined; ignored: string[] } {
	if (!raw || raw.length === 0) return { kinds: undefined, ignored: [] };
	const kinds: HindsightKind[] = [];
	const ignored: string[] = [];
	for (const candidate of raw) {
		if ((HINDSIGHT_KINDS as readonly string[]).includes(candidate)) {
			kinds.push(candidate as HindsightKind);
		} else {
			ignored.push(candidate);
		}
	}
	return { kinds: kinds.length > 0 ? kinds : undefined, ignored };
}

function formatResult(result: HindsightSearchResult): string {
	const { entry } = result;
	const subject = entry.subject ? ` (subject "${entry.subject}")` : "";
	const tags = entry.tags && entry.tags.length > 0 ? ` tags: ${entry.tags.join(", ")}` : "";
	let body = entry.body;
	let truncatedNote = "";
	if (body.length > BODY_TRUNCATE) {
		body = `${sliceSafe(body, 0, BODY_TRUNCATE).trimEnd()}…`;
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
		activity: "navigation",
		label: "recall",
		description:
			"Search the project's hindsight memory bank for relevant entries. Use this before doing redundant investigation — past sessions may have already established the answer.",
		promptSnippet: "Search project hindsight memory",
		promptGuidelines: [
			"At the start of any non-trivial task, recall before grepping or reading widely — prior sessions have likely already established the relevant conventions, decisions, or gotchas.",
		],
		parameters: recallSchema,
		async execute(_toolCallId: string, input: RecallToolInput) {
			const bank = options?.bank ?? getCurrentHindsightBank();
			if (!bank) {
				return {
					content: [
						{
							type: "text" as const,
							text: HINDSIGHT_BANK_ABSENT_MESSAGE,
						},
					],
					details: { matchCount: 0 },
					isError: true,
				};
			}

			const limit =
				typeof input.limit === "number" && input.limit > 0
					? Math.min(Math.floor(input.limit), RECALL_MAX_LIMIT)
					: 10;
			const { kinds, ignored } = coerceKinds(input.kinds);
			const ignoredNote =
				ignored.length > 0
					? `\n\n(ignored unknown kind${ignored.length === 1 ? "" : "s"}: ${ignored.join(", ")} — valid kinds are ${HINDSIGHT_KINDS.join(", ")})`
					: "";
			const { scopes, boostScope } = resolveScope(options?.agentScope, input.scope);
			const results = bank.search({ query: input.query, limit, kinds, scopes, boostScope });
			if (results.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `No hindsight entries matched: ${input.query}${ignoredNote}`,
						},
					],
					details: { matchCount: 0 },
				};
			}
			const blocks = results.map(formatResult);
			const text = `Found ${results.length} hindsight entr${results.length === 1 ? "y" : "ies"} for "${input.query}":\n\n${blocks.join("\n\n---\n\n")}${ignoredNote}`;
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
		renderResult: renderToolOutput,
	};
}

export function createRecallTool(cwd: string, options?: RecallToolOptions): AgentTool<typeof recallSchema> {
	return wrapToolDefinition(createRecallToolDefinition(cwd, options));
}
