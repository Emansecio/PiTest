/**
 * `todo` tool — native task list for tracking multi-step work, modelled after
 * `@juicesharp/rpiv-todo` (MVP: no dependency graph). Action-based; reaches the
 * active TodoManager through the module-level registry. Default-on, so the
 * model can plan tasks proactively.
 */

import type { AgentTool } from "@pit/agent-core";
import { Text } from "@pit/tui";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { getCurrentTodoManager, type TodoItem } from "../todo/todo-manager.ts";
import { getTextOutput } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const todoSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("create"),
				Type.Literal("update"),
				Type.Literal("list"),
				Type.Literal("get"),
				Type.Literal("delete"),
				Type.Literal("clear"),
			],
			{ description: "Operation to perform on the todo list." },
		),
		id: Type.Optional(Type.Number({ description: "Todo id (required for update/get/delete)." })),
		subject: Type.Optional(Type.String({ description: "Short outcome-focused title (required for create)." })),
		description: Type.Optional(Type.String({ description: "Optional longer detail." })),
		activeForm: Type.Optional(
			Type.String({ description: "Present-continuous label shown while in_progress, e.g. 'Writing tests'." }),
		),
		status: Type.Optional(
			Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")], {
				description: "Target status for update, or a filter for list.",
			}),
		),
	},
	{ additionalProperties: false },
);

export type TodoToolInput = Static<typeof todoSchema>;

export interface TodoToolDetails {
	action: TodoToolInput["action"];
	tasks: TodoItem[];
	error?: string;
}

export interface TodoToolOptions {}

function summarize(tasks: TodoItem[]): string {
	if (tasks.length === 0) return "(no todos)";
	const glyph = { completed: "✓", in_progress: "◐", pending: "○" } as const;
	return tasks
		.map((t) => {
			const active = t.status === "in_progress" && t.activeForm ? ` (${t.activeForm})` : "";
			return `${glyph[t.status]} #${t.id} ${t.subject}${active}`;
		})
		.join("\n");
}

export function createTodoToolDefinition(
	_cwd: string,
	_options?: TodoToolOptions,
): ToolDefinition<typeof todoSchema, TodoToolDetails> {
	const fail = (action: TodoToolInput["action"], message: string) => ({
		content: [{ type: "text" as const, text: message }],
		details: { action, tasks: getCurrentTodoManager()?.list() ?? [], error: message },
	});

	return {
		name: "todo",
		label: "todo",
		description:
			"Track multi-step work as a todo list. Actions: create (needs subject), update (needs id; set status/activeForm), list (optional status filter), get (needs id), delete (needs id), clear. Mark one todo in_progress at a time and completed as soon as it is done.",
		promptSnippet: "Plan and track multi-step work as todos",
		promptGuidelines: [
			"For non-trivial multi-step tasks, create todos up front, then keep them current.",
			"Mark exactly one todo in_progress at a time (with a short activeForm) before starting it.",
			"Mark a todo completed immediately when done — do not batch completions.",
		],
		parameters: todoSchema,
		async execute(_toolCallId: string, input: TodoToolInput) {
			const mgr = getCurrentTodoManager();
			if (!mgr) return fail(input.action, "Todo list is unavailable in this session.");

			switch (input.action) {
				case "create": {
					if (!input.subject?.trim()) return fail("create", "create requires a `subject`.");
					const item = mgr.create({
						subject: input.subject,
						description: input.description,
						activeForm: input.activeForm,
					});
					return {
						content: [{ type: "text" as const, text: `Created #${item.id}: ${item.subject}` }],
						details: { action: "create" as const, tasks: mgr.list() },
					};
				}
				case "update": {
					if (input.id === undefined) return fail("update", "update requires an `id`.");
					const item = mgr.update({
						id: input.id,
						subject: input.subject,
						description: input.description,
						activeForm: input.activeForm,
						status: input.status,
					});
					if (!item) return fail("update", `No todo with id ${input.id}.`);
					return {
						content: [{ type: "text" as const, text: `Updated #${item.id} → ${item.status}: ${item.subject}` }],
						details: { action: "update" as const, tasks: mgr.list() },
					};
				}
				case "get": {
					if (input.id === undefined) return fail("get", "get requires an `id`.");
					const item = mgr.get(input.id);
					if (!item) return fail("get", `No todo with id ${input.id}.`);
					return {
						content: [{ type: "text" as const, text: summarize([item]) }],
						details: { action: "get" as const, tasks: [item] },
					};
				}
				case "delete": {
					if (input.id === undefined) return fail("delete", "delete requires an `id`.");
					const ok = mgr.delete(input.id);
					return {
						content: [
							{ type: "text" as const, text: ok ? `Deleted #${input.id}` : `No todo with id ${input.id}.` },
						],
						details: { action: "delete" as const, tasks: mgr.list() },
					};
				}
				case "clear": {
					mgr.clear();
					return {
						content: [{ type: "text" as const, text: "Cleared all todos." }],
						details: { action: "clear" as const, tasks: [] },
					};
				}
				default: {
					const tasks = mgr.list(input.status ? { status: input.status } : undefined);
					return {
						content: [{ type: "text" as const, text: summarize(tasks) }],
						details: { action: "list" as const, tasks },
					};
				}
			}
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const action = typeof args?.action === "string" ? args.action : "";
			text.setText(`${theme.fg("toolTitle", theme.bold("todo"))} ${theme.fg("accent", action)}`);
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

export function createTodoTool(cwd: string, options?: TodoToolOptions): AgentTool<typeof todoSchema> {
	return wrapToolDefinition(createTodoToolDefinition(cwd, options));
}
