/**
 * `forget` tool — removes a single entry from the project-local hindsight bank
 * by its id, by exact subject, or by tags. The id is the one surfaced by
 * `recall`/`reflect` as `[id: ...]`. Deletion is permanent: the bank file is
 * atomically rewritten without the entry. Use this to prune stale, wrong, or
 * no-longer-relevant memories. Subject/tags lookup avoids a recall round-trip
 * when the target is known and unique.
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
		id: Type.Optional(
			Type.String({
				description:
					"The id of the hindsight entry to delete, as shown by `recall`/`reflect` in `[id: ...]`. Takes precedence over `subject`/`tags`.",
			}),
		),
		subject: Type.Optional(
			Type.String({
				description:
					"Delete by exact subject (case-insensitive). Skips the recall round-trip. Combine with `tags` to narrow.",
			}),
		),
		tags: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Delete the entry carrying ALL of these tags (case-insensitive). Combine with `subject` to narrow. If the filter matches multiple entries, none are deleted and their ids are listed.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type ForgetToolInput = Static<typeof forgetSchema>;

export interface ForgetToolDetails {
	id?: string;
	subject?: string;
	tags?: string[];
	deleted: boolean;
	/** When subject/tags matched more than one entry, the ambiguous ids. */
	candidates?: string[];
}

export interface ForgetToolOptions {
	/** Override the active bank (otherwise pulled from the module registry). */
	bank?: HindsightBank;
}

function textResult(text: string, details: ForgetToolDetails, isError?: boolean) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(isError ? { isError: true } : {}),
	};
}

/** Human-readable description of the subject/tags filter, for messages. */
function describeFilter(subject: string | undefined, tags: string[] | undefined): string {
	const parts: string[] = [];
	if (subject) parts.push(`subject "${subject}"`);
	if (tags && tags.length > 0) parts.push(`tags [${tags.join(", ")}]`);
	return parts.join(" + ");
}

export function createForgetToolDefinition(
	_cwd: string,
	options?: ForgetToolOptions,
): ToolDefinition<typeof forgetSchema, ForgetToolDetails> {
	return {
		name: "forget",
		label: "forget",
		description:
			"Delete a single entry from the project's hindsight memory bank — by id (the `[id: ...]` shown by `recall`/`reflect`), by exact `subject`, or by `tags`. Use to prune stale, wrong, or no-longer-relevant memories. Deletion is permanent.",
		promptSnippet: "Delete a hindsight memory entry by id, subject, or tags",
		promptGuidelines: [
			"Use forget to remove memories that are stale, wrong, or superseded. Pass `id` (from `recall`/`reflect`), or `subject`/`tags` to delete by content without recalling first.",
		],
		parameters: forgetSchema,
		async execute(_toolCallId: string, input: ForgetToolInput) {
			const bank = options?.bank ?? getCurrentHindsightBank();
			if (!bank) {
				return textResult(
					"Hindsight bank is not enabled for this session. Set `hindsight.enabled: true` in settings to use retain/recall/reflect/forget.",
					{ id: input.id, subject: input.subject, tags: input.tags, deleted: false },
					true,
				);
			}

			const subject = input.subject?.trim();
			const tags = input.tags?.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
			const hasTagFilter = tags !== undefined && tags.length > 0;

			if (!input.id && !subject && !hasTagFilter) {
				return textResult(
					"Provide `id`, `subject`, or `tags` to identify the entry to forget.",
					{ deleted: false },
					true,
				);
			}

			// Resolve the target id: explicit id wins; otherwise match by subject/tags.
			let targetId = input.id;
			if (!targetId && (subject || hasTagFilter)) {
				let matches = bank.all();
				if (subject) {
					matches = matches.filter((e) => e.subject && e.subject.trim().toLowerCase() === subject.toLowerCase());
				}
				if (hasTagFilter) {
					matches = matches.filter((e) => {
						const entryTags = (e.tags ?? []).map((t) => t.toLowerCase());
						return tags.every((t) => entryTags.includes(t));
					});
				}
				const criterion = describeFilter(subject, tags);
				if (matches.length === 0) {
					return textResult(`No hindsight entry found with ${criterion}`, { subject, tags, deleted: false });
				}
				if (matches.length > 1) {
					const ids = matches.map((e) => e.id);
					const list = ids.map((id) => `  [id: ${id}]`).join("\n");
					return textResult(
						`${matches.length} hindsight entries match ${criterion}. Re-run forget with a specific id:\n${list}`,
						{ subject, tags, deleted: false, candidates: ids },
					);
				}
				targetId = matches[0].id;
			}

			const id = targetId!;
			const existing = bank.get(id);
			if (!existing) {
				return textResult(`No hindsight entry found with id: ${id}`, { id, subject, tags, deleted: false });
			}

			const deleted = bank.delete(id);
			const label = existing.subject ? ` (subject "${existing.subject}")` : "";
			return textResult(
				deleted ? `Forgot hindsight entry [id: ${id}]${label}.` : `No hindsight entry found with id: ${id}`,
				{ id, subject, tags, deleted },
			);
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			let target = str(args?.id);
			if (!target && args?.subject) target = `subject:${str(args.subject)}`;
			if (!target && Array.isArray(args?.tags) && args.tags.length > 0) target = `tags:${args.tags.join(",")}`;
			if (!target) target = "(missing)";
			text.setText(`${theme.fg("toolTitle", theme.bold("forget"))} ${theme.fg("accent", target)}`);
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
