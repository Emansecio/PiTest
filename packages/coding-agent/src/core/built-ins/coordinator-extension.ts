/**
 * Built-in subagent-coordinator extension.
 *
 * Registers a `task` tool the LLM can call to launch a subagent for a focused
 * sub-question. The subagent reuses the parent's model and tool catalog
 * (filtered) but runs in an in-memory session.
 *
 * Recursion is bounded: a spawned subagent never inherits the parent's `task`
 * tool verbatim (that would let it recurse forever through the shared
 * registry). Instead it receives a depth-incremented copy, withheld entirely
 * once the nesting budget runs out. See `buildSubagentToolCatalog`.
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
import type { Skill } from "../skills.ts";

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
				"Stable task identifier used for the worktree path. Defaults to the auto-generated subagent id; collisions are auto-resolved.",
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
	inherit_skills: Type.Optional(
		Type.Boolean({
			description:
				"When true, the parent's model-invocable skills are appended to the subagent's system prompt so it can discover and use them. Default false (subagent runs skill-blind).",
		}),
	),
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

/** Name of the coordinator-spawned tool. Stripped/rebuilt per nesting level. */
const TASK_TOOL_NAME = "task";

/**
 * Brand stamped on every coordinator-spawned tool. The recursion guard strips
 * tools by this brand rather than by name, so a rename of `TASK_TOOL_NAME` — or
 * a user tool that happens to also be named `"task"` — can never break the
 * guard or strip the wrong tool.
 */
export const COORDINATOR_TOOL_BRAND: unique symbol = Symbol("pit.coordinatorTool");

/** True when `tool` is a coordinator-spawned `task` tool (carries the brand). */
function isCoordinatorTool(tool: AgentTool): boolean {
	return (tool as { [COORDINATOR_TOOL_BRAND]?: boolean })[COORDINATOR_TOOL_BRAND] === true;
}

/**
 * Default maximum subagent nesting depth. The parent (depth 0) can always spawn
 * subagents; this caps how deep that nesting may go before the `task` tool is
 * withheld from a subagent's catalog.
 *
 * Default 1: subagents are allowed, but they cannot spawn their own subagents —
 * which prevents the unbounded recursion that a shared, self-including tool
 * catalog would otherwise permit.
 */
const DEFAULT_MAX_SUBAGENT_DEPTH = 1;

/** Resolves the nesting budget, honoring the `PIT_SUBAGENT_MAX_DEPTH` override. */
export function resolveMaxSubagentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PIT_SUBAGENT_MAX_DEPTH;
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_SUBAGENT_DEPTH;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MAX_SUBAGENT_DEPTH;
	return parsed;
}

/**
 * Builds the tool catalog handed to a freshly spawned subagent.
 *
 * The parent's coordinator (`task`) tool is always stripped — a subagent must
 * never inherit the parent's depth-0 tool, which closes over the shared
 * registry and would let it recurse forever. A fresh, depth-incremented
 * coordinator tool is re-added only while the child is still within the nesting
 * budget; deeper subagents simply never see a `task` tool, so they cannot spawn
 * further. Coordinator tools are identified by their brand, not their name.
 */
export function buildSubagentToolCatalog(
	parentTools: readonly AgentTool[],
	childDepth: number,
	maxDepth: number,
	makeCoordinatorTool: (depth: number) => AgentTool,
): AgentTool[] {
	const base = parentTools.filter((tool) => !isCoordinatorTool(tool));
	if (childDepth < maxDepth) {
		return [...base, makeCoordinatorTool(childDepth)];
	}
	return base;
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

export interface CoordinatorExtensionOptions {
	modelRegistry: ModelRegistry;
	/** Parent's permission checker — gates every subagent tool call (headless = ask→deny). */
	permissionChecker?: import("../permissions/index.ts").PermissionChecker;
	/** Provider that returns the parent's currently active model. */
	getParentModel: () => import("@pit/ai").Model<any> | undefined;
	/** Provider that returns the parent's full AgentTool catalog at call time. */
	getAvailableTools: () => AgentTool[];
	/** Provider that returns the parent's loaded skills — used for `inherit_skills`. */
	getSkills?: () => Skill[];
	/** Converts messages — defaults to identity. */
	convertToLlm?: (messages: import("@pit/agent-core").AgentMessage[]) => import("@pit/ai").Message[];
	/** Working directory for git worktree creation. Defaults to process.cwd(). */
	getCwd?: () => string;
}

export function createCoordinatorExtension(options: CoordinatorExtensionOptions) {
	const registry = new SubagentRegistry();
	const maxDepth = resolveMaxSubagentDepth();

	/**
	 * Builds the `task` tool for an agent living at `depth`. The parent gets
	 * depth 0; each spawned subagent that is still within the nesting budget
	 * receives a depth-incremented copy.
	 */
	function makeTaskTool(depth: number) {
		return {
			name: TASK_TOOL_NAME,
			label: TASK_TOOL_NAME,
			[COORDINATOR_TOOL_BRAND]: true,
			description:
				"Spawn a focused subagent to complete an isolated sub-task and return its final answer. " +
				"Use this to delegate research, file exploration, or repetitive checks without polluting the main conversation. " +
				"Pass `result_schema` for structured output, or `worktree: true` to run in an isolated git worktree.",
			promptSnippet:
				"Spawn a subagent to handle an isolated sub-task. Supports structured output via result_schema and isolated git worktrees via worktree.",
			parameters: taskSchema,
			// `params` is typed `unknown`, not `TaskInput`: this tool flows through the
			// shared `(depth) => AgentTool` factory, whose `execute` is contravariantly
			// typed against the erased base schema. A narrower param breaks assignability.
			async execute(_id: string, params: unknown, signal?: AbortSignal) {
				const {
					name,
					prompt,
					system_prompt,
					allowed_tools,
					max_turns,
					result_schema,
					worktree,
					timeout_ms,
					inherit_skills,
				} = params as TaskInput;
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
				// The child runs one level deeper than the tool that spawned it. Strip
				// our own tool from its catalog and re-add a depth-incremented copy
				// only if the nesting budget still allows it.
				const childDepth = depth + 1;
				const childTools = buildSubagentToolCatalog(
					options.getAvailableTools(),
					childDepth,
					maxDepth,
					makeTaskTool,
				);
				try {
					const result = await spawnSubagent(
						{
							registry,
							model,
							modelRegistry: options.modelRegistry,
							availableTools: childTools,
							convertToLlm: options.convertToLlm ?? ((messages) => messages as never),
							permissionChecker: options.permissionChecker,
							skills: options.getSkills?.(),
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
							depth: childDepth,
							inheritSkills: inherit_skills,
						},
					);
					const text =
						resultSchema && result.value !== undefined ? JSON.stringify(result.value, null, 2) : result.output;
					return {
						content: [{ type: "text" as const, text }],
						isError: false,
						details: {
							subagentId: result.record.id,
							taskName: result.record.taskName,
							turns: result.record.turnCount,
							depth: childDepth,
							worktreePath: result.worktreePath,
							hasStructuredValue: result.value !== undefined,
							deniedToolCalls: result.record.deniedToolCalls,
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
		};
	}

	return (pi: ExtensionAPI) => {
		pi.registerTool(makeTaskTool(0));

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
					(r) =>
						`${r.id} [${r.status}] depth=${r.depth} turns=${r.turnCount}${r.deniedToolCalls?.length ? ` denied=${r.deniedToolCalls.length}(${[...new Set(r.deniedToolCalls)].join(",")})` : ""}${r.error ? ` err=${r.error.slice(0, 60)}` : ""}`,
				);
				const out = lines.join("\n");
				if (ctx.hasUI) ctx.ui.notify(out, "info");
				else console.log(out);
			},
		});
	};
}
