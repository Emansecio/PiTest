/**
 * Built-in subagent-coordinator extension.
 *
 * Registers a `task` tool the LLM can call to launch a subagent for a focused
 * sub-question. The subagent reuses the parent's model and tool catalog
 * (filtered) but runs in an in-memory session.
 *
 * Example tool call from the LLM:
 *   task({
 *     name: "find-dead-code",
 *     prompt: "Find unused exports in src/",
 *     allowed_tools: ["read","grep","find"],
 *     result_schema: { type: "object", properties: { findings: { type: "array" } }, required: ["findings"] },
 *     worktree: true,
 *   })
 */

import type { AgentTool } from "@pit/agent-core";
import { type Static, type TSchema, Type } from "typebox";
import { SubagentRegistry, spawnSubagent } from "../coordinator/index.ts";
import type { ExtensionAPI } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";

const worktreeSchema = Type.Union(
	[
		Type.Boolean(),
		Type.Object({
			branch: Type.Optional(Type.String()),
			cleanup: Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("keep")])),
		}),
	],
	{
		description:
			"Set to `true` to run the subagent in an isolated git worktree (auto-cleaned). Or pass an object with optional `branch` and `cleanup: 'auto'|'keep'`.",
	},
);

const taskSchema = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				"Stable task identifier. Used for the agent:// scheme lookup and worktree path. Defaults to the auto-generated subagent id.",
		}),
	),
	prompt: Type.String({ description: "The task description for the subagent." }),
	system_prompt: Type.Optional(Type.String({ description: "Override the subagent's system prompt." })),
	allowed_tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Subset of parent tools the subagent can use. Defaults to parent's full tool set.",
		}),
	),
	max_turns: Type.Optional(Type.Number({ description: "Hard limit on subagent turns. Default: 25." })),
	result_schema: Type.Optional(
		Type.Unknown({
			description:
				"Optional typebox/JSON-Schema describing the expected structured output. May be passed as an object or as a JSON string. When set, the subagent's final message is parsed + validated against this schema.",
		}),
	),
	worktree: Type.Optional(worktreeSchema),
	timeout_ms: Type.Optional(Type.Number({ description: "Hard wall-clock timeout for the subagent in ms." })),
});

type TaskInput = Static<typeof taskSchema>;

export interface CoordinatorExtensionOptions {
	modelRegistry: ModelRegistry;
	/** Provider that returns the parent's currently active model. */
	getParentModel: () => import("@pit/ai").Model<any> | undefined;
	/** Provider that returns the parent's full AgentTool catalog at call time. */
	getAvailableTools: () => AgentTool[];
	/** Converts messages — defaults to identity. */
	convertToLlm?: (messages: import("@pit/agent-core").AgentMessage[]) => import("@pit/ai").Message[];
	/** Working directory for git worktree creation. Defaults to process.cwd(). */
	getCwd?: () => string;
}

function coerceResultSchema(raw: unknown): TSchema | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (!trimmed) return undefined;
		try {
			return JSON.parse(trimmed) as TSchema;
		} catch {
			return undefined;
		}
	}
	if (typeof raw === "object") {
		// Typebox schemas are JSON-Schema-compatible; we accept any object that
		// looks like one and let Value.Check do the structural work at runtime.
		return raw as TSchema;
	}
	return undefined;
}

export function createCoordinatorExtension(options: CoordinatorExtensionOptions) {
	const registry = new SubagentRegistry();

	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "task",
			label: "task",
			description:
				"Spawn a focused subagent to complete an isolated sub-task and return its final answer. " +
				"Use this to delegate research, file exploration, or repetitive checks without polluting the main conversation. " +
				"Pass `result_schema` for structured output, or `worktree: true` to run in an isolated git worktree.",
			promptSnippet:
				"Spawn a subagent to handle an isolated sub-task. Supports structured output via result_schema and isolated git worktrees via worktree.",
			parameters: taskSchema,
			async execute(
				_id,
				{ name, prompt, system_prompt, allowed_tools, max_turns, result_schema, worktree, timeout_ms }: TaskInput,
				signal,
			) {
				const model = options.getParentModel();
				if (!model) {
					return {
						content: [{ type: "text" as const, text: "No model available for subagent." }],
						isError: true,
						details: undefined,
					};
				}
				const resultSchema = coerceResultSchema(result_schema);
				const cwd = options.getCwd ? options.getCwd() : process.cwd();
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
							resultSchema,
							worktree: worktree as boolean | { branch?: string; cleanup?: "auto" | "keep" } | undefined,
							timeoutMs: timeout_ms,
							taskName: name ?? undefined,
							cwd,
						},
					);
					const text =
						resultSchema && result.value !== undefined ? JSON.stringify(result.value, null, 2) : result.output;
					return {
						content: [{ type: "text" as const, text }],
						isError: false,
						details: {
							subagentId: result.record.id,
							taskName: name ?? result.record.id,
							turns: result.record.turnCount,
							worktreePath: result.worktreePath,
							hasStructuredValue: result.value !== undefined,
						},
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
