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

const TODO_ACTIONS = ["set", "create", "update", "list", "get", "delete", "clear"] as const;
const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;

const todoItemSchema = Type.Object(
	{
		id: Type.Optional(Type.Number({ description: "Existing todo id to carry forward. Omit to create a new one." })),
		subject: Type.String({ description: "Short outcome-focused title." }),
		description: Type.Optional(Type.String({ description: "Optional longer detail." })),
		activeForm: Type.Optional(
			Type.String({ description: "Present-continuous label shown while in_progress, e.g. 'Writing tests'." }),
		),
		status: Type.Optional(Type.Enum(TODO_STATUSES, { description: "Defaults to pending." })),
	},
	{ additionalProperties: false },
);

const todoSchema = Type.Object(
	{
		action: Type.Enum(TODO_ACTIONS, { description: "Operation to perform on the todo list." }),
		items: Type.Optional(
			Type.Array(todoItemSchema, {
				description:
					"Whole list, in order (required for set). Replaces the current list — an omitted todo is deleted.",
			}),
		),
		id: Type.Optional(Type.Number({ description: "Todo id (required for update/get/delete)." })),
		subject: Type.Optional(Type.String({ description: "Short outcome-focused title (required for create)." })),
		description: Type.Optional(Type.String({ description: "Optional longer detail." })),
		activeForm: Type.Optional(
			Type.String({ description: "Present-continuous label shown while in_progress, e.g. 'Writing tests'." }),
		),
		status: Type.Optional(
			Type.Enum(TODO_STATUSES, { description: "Target status for update, or a filter for list." }),
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
		isError: true as const,
		details: { action, tasks: getCurrentTodoManager()?.list() ?? [], error: message },
	});

	return {
		name: "todo",
		label: "todo",
		description:
			"Track multi-step work as a todo list. Prefer `set`: it takes the whole list in `items` and replaces it, so any number of changes costs ONE call — send every todo you want to keep, each with its `id`. Other actions: create (needs subject), update (needs id), list (optional status filter), get (needs id), delete (needs id), clear. Keep exactly one todo in_progress at a time and mark it completed as soon as it is done.",
		promptSnippet: "Plan and track multi-step work as todos; prefer `set` — it replaces the whole list in ONE call",
		// No promptGuidelines: WHEN to keep the list current lives in the Todo-first
		// system-prompt guideline, HOW (set replaces the whole list, one call) lives
		// in `description` above — and, telegraphically, in the snippet, which is
		// what the provider wire actually shows (T01).
		parameters: todoSchema,
		async execute(_toolCallId: string, input: TodoToolInput) {
			const mgr = getCurrentTodoManager();
			if (!mgr) return fail(input.action, "Todo list is unavailable in this session.");

			switch (input.action) {
				case "set": {
					if (!input.items) return fail("set", "set requires `items` (the whole list, in order).");
					const bad = input.items.findIndex((t) => !t.subject?.trim());
					if (bad >= 0) return fail("set", `set requires a non-empty \`subject\` on every item (index ${bad}).`);
					const tasks = mgr.set(input.items);
					return {
						content: [{ type: "text" as const, text: summarize(tasks) }],
						details: { action: "set" as const, tasks },
					};
				}
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
			const output = getTextOutput(result, context.showImages).trim();
			// No leading newline: the call and result are separate children of the
			// shell container, which stacks them directly — a `\n` here would insert a
			// blank line between "todo <action>" and its result.
			text.setText(output ? theme.fg("toolOutput", output) : "");
			return text;
		},
	};
}

export function createTodoTool(cwd: string, options?: TodoToolOptions): AgentTool<typeof todoSchema> {
	return wrapToolDefinition(createTodoToolDefinition(cwd, options));
}
