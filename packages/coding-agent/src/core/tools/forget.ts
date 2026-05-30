/**
 * `forget` tool — removes a single entry from the project-local hindsight bank
 * by its id. The id is the one surfaced by `recall`/`reflect` as `[id: ...]`.
 * Deletion is permanent: the bank file is atomically rewritten without the
 * entry. Use this to prune stale, wrong, or no-longer-relevant memories.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentHindsightBank, type HindsightBank } from "../hindsight/index.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const forgetSchema = Type.Object(
	{
		id: Type.String({
			description: "The id of the hindsight entry to delete, as shown by `recall`/`reflect` in `[id: ...]`.",
		}),
	},
	{ additionalProperties: false },
);

export type ForgetToolInput = Static<typeof forgetSchema>;

export interface ForgetToolDetails {
	id: string;
	deleted: boolean;
}

export interface ForgetToolOptions {
	/** Override the active bank (otherwise pulled from the module registry). */
	bank?: HindsightBank;
}

export function createForgetToolDefinition(
	_cwd: string,
	options?: ForgetToolOptions,
): ToolDefinition<typeof forgetSchema, ForgetToolDetails> {
	return {
		name: "forget",
		label: "forget",
		description:
			"Delete a single entry from the project's hindsight memory bank by id (the `[id: ...]` shown by `recall`/`reflect`). Use to prune stale, wrong, or no-longer-relevant memories. Deletion is permanent.",
		promptSnippet: "Delete a hindsight memory entry by id",
		promptGuidelines: [
			"Use forget to remove memories that are stale, wrong, or superseded. Get the id from `recall`/`reflect` first.",
		],
		parameters: forgetSchema,
		async execute(_toolCallId: string, input: ForgetToolInput) {
			const bank = options?.bank ?? getCurrentHindsightBank();
			if (!bank) {
				return {
					content: [
						{
							type: "text" as const,
							text: "Hindsight bank is not enabled for this session. Set `hindsight.enabled: true` in settings to use retain/recall/reflect/forget.",
						},
					],
					details: { id: input.id, deleted: false },
					isError: true,
				};
			}

			const existing = bank.get(input.id);
			if (!existing) {
				return {
					content: [{ type: "text" as const, text: `No hindsight entry found with id: ${input.id}` }],
					details: { id: input.id, deleted: false },
				};
			}

			const deleted = bank.delete(input.id);
			const label = existing.subject ? ` (subject "${existing.subject}")` : "";
			return {
				content: [
					{
						type: "text" as const,
						text: deleted
							? `Forgot hindsight entry [id: ${input.id}]${label}.`
							: `No hindsight entry found with id: ${input.id}`,
					},
				],
				details: { id: input.id, deleted },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const id = str(args?.id) || "(missing)";
			text.setText(`${theme.fg("toolTitle", theme.bold("forget"))} ${theme.fg("accent", id)}`);
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

export function createForgetTool(cwd: string, options?: ForgetToolOptions): AgentTool<typeof forgetSchema> {
	return wrapToolDefinition(createForgetToolDefinition(cwd, options));
}
