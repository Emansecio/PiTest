/**
 * `pin` tool — the model's side of P5 `/pin`: mark a RARE, load-bearing fact or
 * file so it survives compaction. Reaches the active PinManager through the
 * module-level registry (mirrors `todo`/`plan`). The user owns the pin list:
 * `remove` on a user-created pin always fails here — see PinManager.unpin.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentPinManager, type PinItem } from "../pins.ts";
import { resolveReadPath } from "./path-utils.ts";
import { getTextOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const pinSchema = Type.Object(
	{
		op: Type.Union(
			[Type.Literal("add_fact"), Type.Literal("add_file"), Type.Literal("remove"), Type.Literal("list")],
			{
				description:
					"add_fact: pin a short fact (needs text). add_file: pin a file path so its reads/edits survive pruning (needs path). remove: unpin by id (needs id) — fails if the pin was created by the user. list: show current pins.",
			},
		),
		text: Type.Optional(Type.String({ description: "Fact text for add_fact." })),
		path: Type.Optional(Type.String({ description: "File path for add_file (resolved against the session cwd)." })),
		id: Type.Optional(Type.String({ description: "Pin id for remove, e.g. 'p3'." })),
	},
	{ additionalProperties: false },
);

export type PinToolInput = Static<typeof pinSchema>;

export interface PinToolDetails {
	op: PinToolInput["op"];
	items: PinItem[];
	error?: string;
}

export interface PinToolOptions {}

function summarize(items: readonly PinItem[]): string {
	if (items.length === 0) return "(no pins)";
	return items
		.map((p) => {
			const body = p.kind === "fact" ? p.text : p.displayPath;
			return `#${p.id} ${p.kind} ${body} (${p.createdBy})`;
		})
		.join("\n");
}

export function createPinToolDefinition(
	cwd: string,
	_options?: PinToolOptions,
): ToolDefinition<typeof pinSchema, PinToolDetails> {
	const fail = (op: PinToolInput["op"], message: string) => ({
		content: [{ type: "text" as const, text: message }],
		isError: true as const,
		details: { op, items: [...(getCurrentPinManager()?.list() ?? [])], error: message },
	});

	return {
		name: "pin",
		label: "pin",
		description:
			"Pin a critical decision or file so it survives context compaction. RARE — reserve for load-bearing facts the user explicitly stated (a hard constraint, an irreversible decision, a must-not-touch file), not routine notes (use `todo` for everyday task tracking). Ops: add_fact (needs text; capped at 16 pins total), add_file (needs path — protects its reads/edits from pruning, does not substitute for re-reading), remove (needs id — a pin the user created can only be removed by the user, via /unpin), list.",
		promptSnippet: "Pin a rare, load-bearing fact or file so it survives compaction",
		promptGuidelines: [
			"Use `pin` sparingly: only for something the user explicitly marked as critical and never to be forgotten or dropped (a hard constraint, a must-not-touch file). Everyday task tracking stays on `todo`.",
		],
		parameters: pinSchema,
		async execute(_toolCallId: string, input: PinToolInput) {
			const mgr = getCurrentPinManager();
			if (!mgr) return fail(input.op, "Pins are unavailable in this session.");

			switch (input.op) {
				case "add_fact": {
					if (!input.text?.trim()) return fail("add_fact", "add_fact requires `text`.");
					try {
						const item = mgr.pinFact(input.text, "model");
						return {
							content: [{ type: "text" as const, text: `Pinned #${item.id}: ${item.text}` }],
							details: { op: "add_fact" as const, items: [...mgr.list()] },
						};
					} catch (error) {
						return fail("add_fact", (error as Error).message);
					}
				}
				case "add_file": {
					if (!input.path?.trim()) return fail("add_file", "add_file requires `path`.");
					const absPath = resolveReadPath(input.path, cwd);
					const before = mgr.list().length;
					try {
						const item = mgr.pinFile(absPath, cwd, "model");
						const verb = mgr.list().length > before ? "Pinned" : "Already pinned";
						return {
							content: [{ type: "text" as const, text: `${verb} #${item.id}: ${item.displayPath}` }],
							details: { op: "add_file" as const, items: [...mgr.list()] },
						};
					} catch (error) {
						return fail("add_file", (error as Error).message);
					}
				}
				case "remove": {
					if (!input.id?.trim()) return fail("remove", "remove requires an `id`.");
					const existing = mgr.list().find((p) => p.id === input.id);
					const ok = mgr.unpin(input.id, "model");
					if (ok) {
						return {
							content: [{ type: "text" as const, text: `Unpinned #${input.id}` }],
							details: { op: "remove" as const, items: [...mgr.list()] },
						};
					}
					const message = existing
						? `#${input.id} was pinned by the user — only the user can remove it (/unpin ${input.id}).`
						: `No pin with id ${input.id}.`;
					return fail("remove", message);
				}
				default: {
					const items = mgr.list();
					return {
						content: [{ type: "text" as const, text: summarize(items) }],
						details: { op: "list" as const, items: [...items] },
					};
				}
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const op = typeof args?.op === "string" ? args.op : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("pin"))} ${theme.fg("accent", op)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages).trim();
			// No leading newline: call and result are stacked children of the shell
			// container; a `\n` here would insert a blank line between them.
			text.setText(output ? theme.fg("toolOutput", output) : "");
			return text;
		},
	};
}

export function createPinTool(cwd: string, options?: PinToolOptions): AgentTool<typeof pinSchema> {
	return wrapToolDefinition(createPinToolDefinition(cwd, options));
}
