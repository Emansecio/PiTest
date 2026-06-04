/**
 * `reflect` tool — dumps every hindsight entry relevant to a question into a
 * single Markdown block so the calling model can synthesize an answer.
 *
 * Unlike `recall`, this one is meant for "give me everything you know about X"
 * scenarios. No LLM is called from here; the model that invoked the tool does
 * the synthesis from the returned context.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	getCurrentHindsightBank,
	type HindsightBank,
	type HindsightEntry,
	type HindsightSearchResult,
} from "../hindsight/index.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const MAX_BYTES = 4 * 1024;
const REFLECT_LIMIT = 20;

const reflectSchema = Type.Object(
	{
		question: Type.String({
			description:
				"The question to reflect on. Returns ALL relevant hindsight entries as a single block for you to synthesize.",
		}),
	},
	{ additionalProperties: false },
);

export type ReflectToolInput = Static<typeof reflectSchema>;

export interface ReflectToolDetails {
	matchCount: number;
	includedCount: number;
	truncated: boolean;
}

export interface ReflectToolOptions {
	bank?: HindsightBank;
}

function formatEntry(entry: HindsightEntry): string {
	const subject = entry.subject ? ` (subject "${entry.subject}")` : "";
	const tags = entry.tags && entry.tags.length > 0 ? `\ntags: ${entry.tags.join(", ")}` : "";
	return `## ${entry.kind}${subject} [id: ${entry.id}]${tags}\n${entry.body}`;
}

/**
 * Pack results into <= MAX_BYTES of output. Older entries drop first when we
 * hit the cap. Returns the assembled body plus the number of entries kept.
 */
function packResults(
	question: string,
	results: HindsightSearchResult[],
): { text: string; included: number; truncated: boolean } {
	const header = `# Reflection on: ${question}\n\nFound ${results.length} entr${results.length === 1 ? "y" : "ies"} that may be relevant:\n\n`;

	// Sort newest first so the youngest entries survive a budget squeeze.
	const sorted = results.slice().sort((a, b) => b.entry.createdAt - a.entry.createdAt);
	const formatted = sorted.map((r) => formatEntry(r.entry));

	let included = formatted.length;
	let body = formatted.join("\n\n");
	let text = `${header}${body}`;
	let truncated = false;
	while (Buffer.byteLength(text, "utf-8") > MAX_BYTES && included > 0) {
		included -= 1;
		truncated = true;
		const sliced = formatted.slice(0, included);
		body = sliced.join("\n\n");
		text =
			included > 0
				? `${header}${body}\n\n(omitted ${formatted.length - included} older entr${formatted.length - included === 1 ? "y" : "ies"} to stay within the 4KB budget)`
				: `${header}(all entries omitted to stay within the 4KB budget; use \`recall\` with a narrower query)`;
	}

	return { text, included, truncated };
}

export function createReflectToolDefinition(
	_cwd: string,
	options?: ReflectToolOptions,
): ToolDefinition<typeof reflectSchema, ReflectToolDetails> {
	return {
		name: "reflect",
		activity: "navigation",
		label: "reflect",
		description:
			"Give me everything I know about X. Returns up to 20 hindsight entries relevant to the question as a single Markdown block for you to synthesize. Use when you want broad context, not a targeted lookup (for that, use `recall`).",
		promptSnippet: "Dump all hindsight entries relevant to a question",
		promptGuidelines: [
			"When starting broad or unfamiliar work, reflect on the topic up front to load all relevant memory at once before diving in.",
			"Use reflect when you want every relevant memory at once and will synthesize the answer yourself. For pinpoint lookups, prefer recall.",
		],
		parameters: reflectSchema,
		async execute(_toolCallId: string, input: ReflectToolInput) {
			const bank = options?.bank ?? getCurrentHindsightBank();
			if (!bank) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Hindsight bank is not enabled for this session.",
						},
					],
					details: { matchCount: 0, includedCount: 0, truncated: false },
					isError: true,
				};
			}

			const results = bank.search({ query: input.question, limit: REFLECT_LIMIT });
			if (results.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: `# Reflection on: ${input.question}\n\nNo hindsight entries matched.`,
						},
					],
					details: { matchCount: 0, includedCount: 0, truncated: false },
				};
			}

			const packed = packResults(input.question, results);
			return {
				content: [{ type: "text" as const, text: packed.text }],
				details: {
					matchCount: results.length,
					includedCount: packed.included,
					truncated: packed.truncated,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const question = str(args?.question) || "(missing)";
			text.setText(`${theme.fg("toolTitle", theme.bold("reflect"))} ${theme.fg("accent", question)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			text.setText(output ? `\n${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

export function createReflectTool(cwd: string, options?: ReflectToolOptions): AgentTool<typeof reflectSchema> {
	return wrapToolDefinition(createReflectToolDefinition(cwd, options));
}
