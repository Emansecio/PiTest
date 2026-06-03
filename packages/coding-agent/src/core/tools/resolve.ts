/**
 * `resolve` tool — commit or discard a preview staged by edit/edit_v2/write
 * with `{ preview: true }`.
 *
 * Pattern: stage (mutation tool returns id) -> review -> resolve.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentPreviewQueue, type PreviewQueue } from "../preview-queue.ts";
import { getTextOutput, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const resolveSchema = Type.Object(
	{
		id: Type.String({
			description: '8-char preview id returned by the staging tool. Use "*" to resolve all staged previews at once.',
		}),
		action: Type.Union([Type.Literal("accept"), Type.Literal("discard")], {
			description: "accept commits the staged mutation to disk; discard drops it.",
		}),
		reason: Type.Optional(Type.String({ description: "Optional one-line note shown in the TUI." })),
	},
	{ additionalProperties: false },
);

export type ResolveToolInput = Static<typeof resolveSchema>;

export interface ResolveToolDetails {
	accepted: string[];
	discarded: string[];
	failed: Array<{ id: string; error: string }>;
}

export interface ResolveToolOptions {
	/** Inject a queue for tests. Falls back to the module-level current queue. */
	queue?: PreviewQueue;
}

function textResult(
	text: string,
	details: ResolveToolDetails,
): { content: Array<{ type: "text"; text: string }>; details: ResolveToolDetails } {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

export function createResolveToolDefinition(
	_cwd: string,
	options?: ResolveToolOptions,
): ToolDefinition<typeof resolveSchema, ResolveToolDetails> {
	return {
		name: "resolve",
		label: "resolve",
		description:
			'Commit or discard a preview staged by edit, edit_v2, or write with { preview: true }. Pattern: stage -> review -> resolve. Pass the 8-char id returned by the staging tool, or "*" with action=accept to apply all staged previews in order.',
		promptSnippet: "Commit or discard a staged preview",
		promptGuidelines: [
			"Call resolve only after a previous edit/edit_v2/write returned a preview id.",
			"action=accept writes to disk; action=discard drops the staged change.",
			'id="*" with action=accept applies every staged preview in insertion order.',
		],
		parameters: resolveSchema,
		async execute(_toolCallId, input: ResolveToolInput) {
			const queue = options?.queue ?? getCurrentPreviewQueue();
			const details: ResolveToolDetails = { accepted: [], discarded: [], failed: [] };

			if (!queue) {
				return textResult("No preview queue active.", details);
			}

			const id = input.id;
			const action = input.action;

			if (id === "*") {
				if (action === "discard") {
					const items = queue.list();
					for (const item of items) {
						const ok = await queue.discard(item.id);
						if (ok) details.discarded.push(item.id);
					}
					return textResult(`Discarded ${details.discarded.length} preview(s).`, details);
				}
				// accept all in insertion order
				const items = queue.list();
				for (const item of items) {
					const result = await queue.accept(item.id);
					if (result.ok) {
						details.accepted.push(item.id);
					} else {
						details.failed.push({ id: item.id, error: result.error });
					}
				}
				const parts: string[] = [];
				parts.push(`Accepted ${details.accepted.length} preview(s).`);
				if (details.failed.length > 0) {
					parts.push(`Failed: ${details.failed.map((f) => `${f.id} (${f.error})`).join("; ")}`);
				}
				return textResult(parts.join(" "), details);
			}

			const item = queue.get(id);
			if (!item) {
				return textResult(`No preview found for id ${id}.`, details);
			}

			if (action === "discard") {
				await queue.discard(id);
				details.discarded.push(id);
				return textResult(`Discarded preview ${id} (${item.path}).`, details);
			}

			const result = await queue.accept(id);
			if (result.ok) {
				details.accepted.push(id);
				return textResult(`Accepted preview ${id} (${item.path}).`, details);
			}
			details.failed.push({ id, error: result.error });
			return textResult(`Failed to accept ${id}: ${result.error}`, details);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const id = str(args?.id);
			const action = str(args?.action);
			const idDisplay = id ? theme.fg("accent", id) : theme.fg("toolOutput", "...");
			const actionDisplay = action ? theme.fg("toolOutput", action) : "";
			text.setText(
				`${theme.fg("toolTitle", theme.bold("resolve"))} ${idDisplay}${actionDisplay ? ` ${actionDisplay}` : ""}`,
			);
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

export function createResolveTool(cwd: string, options?: ResolveToolOptions): AgentTool<typeof resolveSchema> {
	return wrapToolDefinition(createResolveToolDefinition(cwd, options));
}
