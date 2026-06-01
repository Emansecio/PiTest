/**
 * `recall_tool_output` tool — retrieve the full text of a tool output that was
 * deferred out of context during compaction. The model uses the id from a
 * `[Tool output deferred … id=…]` placeholder to re-fetch on demand.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import { getCurrentDeferredOutputStore } from "../deferred-output-store.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const recallToolOutputSchema = Type.Object(
	{
		id: Type.String({ description: "The deferred output id, e.g. 'd3'." }),
	},
	{ additionalProperties: false },
);

export type RecallToolOutputInput = Static<typeof recallToolOutputSchema>;

export interface RecallToolOutputDetails {
	found: boolean;
}

export function createRecallToolOutputDefinition(
	_cwd: string,
): ToolDefinition<typeof recallToolOutputSchema, RecallToolOutputDetails> {
	return {
		name: "recall_tool_output",
		label: "recall_tool_output",
		description:
			"Retrieve the full text of a tool output that was deferred out of context during compaction. Use the id from a `[Tool output deferred … id=…]` placeholder.",
		promptSnippet: "Retrieve a tool output deferred during compaction by its id",
		parameters: recallToolOutputSchema,
		async execute(_toolCallId, input: RecallToolOutputInput) {
			const store = getCurrentDeferredOutputStore();
			if (!store) {
				return {
					content: [{ type: "text" as const, text: "Deferred-output store unavailable." }],
					details: { found: false },
					isError: true,
				};
			}
			const content = store.get(input.id);
			if (!content) {
				return {
					content: [{ type: "text" as const, text: `No deferred output with id "${input.id}".` }],
					details: { found: false },
					isError: true,
				};
			}
			return {
				content: [{ type: "text" as const, text: content }],
				details: { found: true },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const id = str(args?.id);
			const display = id ? theme.fg("accent", id) : "...";
			text.setText(`${theme.fg("toolTitle", theme.bold("recall_tool_output"))} ${display}`);
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

export function createRecallToolOutputTool(_cwd: string): AgentTool<typeof recallToolOutputSchema> {
	return wrapToolDefinition(createRecallToolOutputDefinition(_cwd));
}
