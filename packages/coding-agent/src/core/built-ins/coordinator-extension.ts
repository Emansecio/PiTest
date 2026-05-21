/**
 * Built-in subagent-coordinator extension.
 *
 * Registers a `task` tool the LLM can call to launch a subagent for a focused
 * sub-question. The subagent reuses the parent's model and tool catalog
 * (filtered) but runs in an in-memory session.
 *
 * Example tool call from the LLM:
 *   task({ prompt: "find all unused imports in src/", allowed_tools: ["read","grep","find"] })
 */

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import { SubagentRegistry, spawnSubagent } from "../coordinator/index.ts";
import type { ExtensionAPI } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";

const taskSchema = Type.Object({
	prompt: Type.String({ description: "The task description for the subagent." }),
	system_prompt: Type.Optional(Type.String({ description: "Override the subagent's system prompt." })),
	allowed_tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Subset of parent tools the subagent can use. Defaults to parent's full tool set.",
		}),
	),
	max_turns: Type.Optional(Type.Number({ description: "Hard limit on subagent turns. Default: 25." })),
});

type TaskInput = Static<typeof taskSchema>;

export interface CoordinatorExtensionOptions {
	modelRegistry: ModelRegistry;
	/** Provider that returns the parent's currently active model. */
	getParentModel: () => import("@earendil-works/pi-ai").Model<any> | undefined;
	/** Provider that returns the parent's full AgentTool catalog at call time. */
	getAvailableTools: () => AgentTool[];
	/** Converts messages — defaults to identity. */
	convertToLlm?: (
		messages: import("@earendil-works/pi-agent-core").AgentMessage[],
	) => import("@earendil-works/pi-ai").Message[];
}

export function createCoordinatorExtension(options: CoordinatorExtensionOptions) {
	const registry = new SubagentRegistry();

	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "task",
			label: "task",
			description:
				"Spawn a focused subagent to complete an isolated sub-task and return its final answer. " +
				"Use this to delegate research, file exploration, or repetitive checks without polluting the main conversation.",
			promptSnippet: "Spawn a subagent to handle an isolated sub-task and return its summary as a string.",
			parameters: taskSchema,
			async execute(_id, { prompt, system_prompt, allowed_tools, max_turns }: TaskInput, signal) {
				const model = options.getParentModel();
				if (!model) {
					return {
						content: [{ type: "text" as const, text: "No model available for subagent." }],
						isError: true,
						details: undefined,
					};
				}
				try {
					const result = await spawnSubagent(
						{
							registry,
							model,
							modelRegistry: options.modelRegistry,
							availableTools: options.getAvailableTools(),
							convertToLlm: options.convertToLlm ?? ((messages) => messages as never),
						},
						{
							prompt,
							systemPrompt: system_prompt,
							allowedTools: allowed_tools,
							maxTurns: max_turns,
							signal,
						},
					);
					return {
						content: [{ type: "text" as const, text: result.output }],
						isError: false,
						details: { subagentId: result.record.id, turns: result.record.turnCount },
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `Subagent failed: ${message}` }],
						isError: true,
						details: undefined,
					};
				}
			},
		});

		pi.registerCommand("tasks", {
			description: "List recently spawned subagents and their status.",
			async handler(_args, ctx) {
				const records = registry.list();
				if (records.length === 0) {
					const msg = "No subagents spawned yet.";
					if (ctx.hasUI) ctx.ui.notify(msg, "info");
					else console.log(msg);
					return;
				}
				const lines = records.map(
					(r) => `${r.id} [${r.status}] turns=${r.turnCount}${r.error ? ` err=${r.error.slice(0, 60)}` : ""}`,
				);
				const out = lines.join("\n");
				if (ctx.hasUI) ctx.ui.notify(out, "info");
				else console.log(out);
			},
		});
	};
}
