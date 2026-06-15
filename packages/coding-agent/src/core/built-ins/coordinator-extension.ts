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

import type { Agent, AgentTool, ThinkingLevel } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import { type Static, type TSchema, Type } from "typebox";
import { isValidThinkingLevel } from "../../cli/args.ts";
import { SubagentRegistry, spawnSubagent } from "../coordinator/index.ts";
import type { SpawnSubagentResult } from "../coordinator/types.ts";
import type { ExtensionAPI } from "../extensions/types.ts";
import { agentMessageBus, makeAgentDelivery, makeAgentResponder } from "../messaging/index.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { parseModelPattern } from "../model-resolver.ts";
import type { Skill } from "../skills.ts";
import { createMessageTool } from "../tools/message.ts";
import { formatSize, truncateTail } from "../tools/truncate.ts";

/** A subagent launched via `task({op:"spawn"})` — runs detached, collected later via poll/join. */
interface PendingTask {
	handle: string;
	status: "running" | "done" | "error";
	promise: Promise<void>;
	controller: AbortController;
	startedAt: number;
	result?: string;
	error?: string;
	/** True once the result was re-injected into the chat, so poll/join don't repeat the payload. */
	delivered?: boolean;
}

/** Shared result shape for every `task` op so the inferred tool `details` type unifies. */
type TaskOpResult = {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
	details: Record<string, unknown> | undefined;
};

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
	op: Type.Optional(
		Type.Union(
			[Type.Literal("run"), Type.Literal("spawn"), Type.Literal("poll"), Type.Literal("join"), Type.Literal("list")],
			{
				description:
					"run (default, blocking — returns the answer) | spawn (non-blocking — returns a handle so you can keep working) | poll (status of handles) | join (await handles and collect their outputs) | list (active subagents). Use spawn+join to fan out N independent tasks in parallel and gather them.",
			},
		),
	),
	name: Type.Optional(
		Type.String({
			description:
				"Stable task identifier, also used as the handle for spawn/poll/join and the worktree path. Defaults to the auto-generated subagent id; collisions are auto-resolved.",
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"Model for the subagent. If the user explicitly asked for a specific model or effort for the subagents, HONOR THAT FIRST. " +
				"Otherwise CHOOSE BY THE SUB-TASK'S COMPLEXITY, picking the smallest model that can do the job well. " +
				"Trivial/mechanical (search, read, list, extract, classify, summarize, repetitive same-shape probes) → 'haiku'. " +
				"Focused analysis or simple, low-risk code → 'sonnet'. " +
				"Hard reasoning, intricate or critical code, architecture/design decisions, tricky debugging, multi-source synthesis → OMIT this to inherit the parent's model (or 'opus'). " +
				"When unsure, OMIT it — never trade quality for cost on a hard sub-task. " +
				"Pattern: 'haiku' | 'sonnet' | 'opus' | 'provider/id' (optionally ':level', e.g. 'opus:high').",
		}),
	),
	thinking_level: Type.Optional(
		Type.String({
			description:
				"Reasoning level: minimal|low|medium|high|xhigh. Defaults to 'medium' — subagents always think ('off' is coerced to 'medium').",
		}),
	),
	handles: Type.Optional(
		Type.Array(Type.String(), {
			description: "Task handles to poll or join (each is the `name`/handle returned by a prior op:'spawn').",
		}),
	),
	prompt: Type.Optional(
		Type.String({ description: "The task description for the subagent (required for run/spawn)." }),
	),
	system_prompt: Type.Optional(Type.String({ description: "Override the subagent's system prompt." })),
	allowed_tools: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Subset of parent tools the subagent can use. Omitting this inherits the parent's FULL tool catalog, " +
				"which inflates the subagent's system prompt with every tool definition — costly and distracting. " +
				"Always pass a minimal subset scoped to the task — e.g. ['read','grep','find','ls'] for exploration.",
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
 * Default byte cap on a subagent's final output as it lands in the parent's
 * context. Without it, a verbose subagent (or a giant structured result) floods
 * the parent conversation. The tail is kept — the subagent's summary/conclusion
 * usually lands at the end — and the full output stays on the in-memory registry.
 */
const DEFAULT_SUBAGENT_MAX_BYTES = 24 * 1024; // 24KB
const SUBAGENT_MAX_LINES = 1000;

/** Resolves the subagent output cap, honoring the `PIT_SUBAGENT_MAX_BYTES` override. */
export function resolveSubagentMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PIT_SUBAGENT_MAX_BYTES;
	if (raw === undefined || raw.trim() === "") return DEFAULT_SUBAGENT_MAX_BYTES;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SUBAGENT_MAX_BYTES;
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
	/** True when inter-agent messaging is enabled (default-on setting). */
	isMessagingEnabled?: () => boolean;
	/** The parent/session's own bus id, so subagents can address it. */
	getParentMessagingId?: () => string | undefined;
	/** Per-message reply timeout (ms) from settings. */
	getMessagingTimeoutMs?: () => number | undefined;
	/**
	 * Called when an async (op:"spawn") subagent settles, with the same string
	 * op:"join" would return. The parent session re-injects it into the chat so
	 * the model never has to poll. Absent → spawn stays poll-only (legacy).
	 */
	onAsyncComplete?: (handle: string, text: string, status: "done" | "error") => boolean;
}

function messagingPreamble(selfId: string, parentId: string | undefined): string {
	const parent = parentId ? `Your spawning agent is \`${parentId}\`. ` : "";
	return (
		"## Coordination\n" +
		`You are agent \`${selfId}\`. Other agents may be running in parallel. ${parent}` +
		'Use the `message` tool to coordinate: `op:"list"` shows who is online; `op:"send"` with `to` ' +
		'(an agent id or "all") and `message` asks a question and returns their reply synchronously. ' +
		"If you are blocked on something another agent owns (a path, a decision, a file you both touch), " +
		"ask them instead of guessing. Keep messages short and prose-only."
	);
}

export function createCoordinatorExtension(options: CoordinatorExtensionOptions) {
	const registry = new SubagentRegistry();
	const maxDepth = resolveMaxSubagentDepth();
	const maxOutputBytes = resolveSubagentMaxBytes();

	// Detached subagents launched via op:"spawn", keyed by handle. Collected via
	// op:"poll"/"join"; a joined handle is freed once settled.
	const pending = new Map<string, PendingTask>();
	let asyncTaskCounter = 0;

	/**
	 * Resolves the subagent's model + thinking level from the task params. A bare
	 * pattern ("haiku", "opus:high", "provider/id") is matched against the
	 * registry; on no match the parent's model is kept. Thinking defaults to
	 * "medium" and is never "off" — the rule is that subagents always think.
	 */
	async function resolveSubModel(
		modelPattern: string | undefined,
		thinkingPattern: string | undefined,
	): Promise<{ model: Model<any> | undefined; thinkingLevel: ThinkingLevel | undefined }> {
		let model = options.getParentModel();
		let thinkingLevel: ThinkingLevel | undefined;
		const trimmed = modelPattern?.trim();
		if (trimmed) {
			try {
				const available = await options.modelRegistry.getAvailable();
				const parsed = parseModelPattern(trimmed, available);
				if (parsed.model) {
					model = parsed.model;
					if (parsed.thinkingLevel) thinkingLevel = parsed.thinkingLevel;
				}
			} catch {
				// Keep the parent model on any resolution failure.
			}
		}
		if (thinkingPattern && isValidThinkingLevel(thinkingPattern)) thinkingLevel = thinkingPattern as ThinkingLevel;
		if (thinkingLevel === "off") thinkingLevel = "medium";
		return { model, thinkingLevel };
	}

	/** Formats a settled subagent result into the capped text the parent sees. */
	function formatSpawnResult(result: SpawnSubagentResult, resultSchema: TSchema | undefined): string {
		const rawText =
			resultSchema && result.value !== undefined ? JSON.stringify(result.value, null, 2) : result.output;
		const capped = truncateTail(rawText, { maxBytes: maxOutputBytes, maxLines: SUBAGENT_MAX_LINES });
		return capped.truncated
			? `${capped.content}\n\n[subagent output truncated to ${formatSize(capped.outputBytes)} of ${formatSize(capped.totalBytes)}; re-spawn with a narrower prompt or a result_schema if you need the elided part]`
			: capped.content;
	}

	/** op:"list" — summarize tracked subagents and live async handles. */
	function listSubagents(): TaskOpResult {
		const records = registry.list();
		const recLines = records.map(
			(r) => `- ${r.taskName} [${r.status}] turns=${r.turnCount}${r.error ? ` (${r.error})` : ""}`,
		);
		const handleLines = [...pending.values()].map(
			(e) => `- ${e.handle} [${e.status}]${e.error ? ` (${e.error})` : ""}`,
		);
		const sections: string[] = [];
		sections.push(
			records.length ? `Subagents (${records.length}):\n${recLines.join("\n")}` : "No subagents tracked.",
		);
		if (handleLines.length) sections.push(`Async handles (${handleLines.length}):\n${handleLines.join("\n")}`);
		return {
			content: [{ type: "text" as const, text: sections.join("\n\n") }],
			isError: false,
			details: { subagents: records.length, asyncHandles: pending.size },
		};
	}

	/** op:"poll" — non-blocking status of the given async handles. */
	function pollHandles(handles: string[]): TaskOpResult {
		if (handles.length === 0) {
			return {
				content: [{ type: "text" as const, text: "task: poll needs `handles`." }],
				isError: true,
				details: undefined,
			};
		}
		const lines = handles.map((h) => {
			const e = pending.get(h);
			if (!e) return `${h}: unknown handle`;
			if (e.status === "running") return `${h}: running`;
			if (e.status === "error") return `${h}: error — ${e.error ?? "failed"}`;
			if (e.delivered) return `${h}: done (already delivered to chat)`;
			return `${h}: done (collect with op:"join")`;
		});
		const anyDone = handles.some((h) => pending.get(h)?.status === "done");
		const allSettled = handles.every((h) => {
			const s = pending.get(h)?.status;
			return s === "done" || s === "error";
		});
		return {
			content: [{ type: "text" as const, text: lines.join("\n") }],
			isError: false,
			details: { anyDone, allSettled },
		};
	}

	/** op:"join" — await the given async handles, return their outputs, and free settled handles. */
	async function joinHandles(handles: string[]): Promise<TaskOpResult> {
		if (handles.length === 0) {
			return {
				content: [{ type: "text" as const, text: "task: join needs `handles`." }],
				isError: true,
				details: undefined,
			};
		}
		const entries = handles.map((h) => pending.get(h)).filter((e): e is PendingTask => e !== undefined);
		await Promise.allSettled(entries.map((e) => e.promise));
		const parts = handles.map((h) => {
			const e = pending.get(h);
			if (!e) return `### ${h}\n(unknown handle)`;
			if (e.status === "error") return `### ${h}\n[failed: ${e.error ?? "error"}]`;
			if (e.delivered)
				return `### ${h}\n(already delivered to the chat automatically when it finished — not repeated)`;
			return `### ${h}\n${e.result ?? "(no output)"}`;
		});
		for (const h of handles) {
			const e = pending.get(h);
			if (e && e.status !== "running") pending.delete(h);
		}
		return {
			content: [{ type: "text" as const, text: parts.join("\n\n") }],
			isError: false,
			details: { joined: entries.length },
		};
	}

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
				"Pass `result_schema` for structured output, or `worktree: true` to run in an isolated git worktree. " +
				"Scale the subagent's `model` to the sub-task's complexity (cheap for trivial fan-out, inherit the parent's for hard reasoning) — see the `model` field.",
			promptSnippet:
				"Spawn a subagent to handle an isolated sub-task. Supports structured output via result_schema and isolated git worktrees via worktree.",
			parameters: taskSchema,
			// `params` is typed `unknown`, not `TaskInput`: this tool flows through the
			// shared `(depth) => AgentTool` factory, whose `execute` is contravariantly
			// typed against the erased base schema. A narrower param breaks assignability.
			async execute(_id: string, params: unknown, signal?: AbortSignal): Promise<TaskOpResult> {
				const p = params as TaskInput;
				const op = p.op ?? "run";

				if (op === "list") return listSubagents();
				if (op === "poll") return pollHandles(p.handles ?? []);
				if (op === "join") return await joinHandles(p.handles ?? []);

				// op === "run" | "spawn": both need a prompt and a model.
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
				} = p;
				if (!prompt || !prompt.trim()) {
					return {
						content: [{ type: "text" as const, text: "task: `prompt` is required for run/spawn." }],
						isError: true,
						details: undefined,
					};
				}
				const model = options.getParentModel();
				if (!model) {
					return {
						content: [{ type: "text" as const, text: "No model available for subagent." }],
						isError: true,
						details: undefined,
					};
				}
				const { model: subModel, thinkingLevel: subThinking } = await resolveSubModel(p.model, p.thinking_level);
				const resultSchema = coerceResultSchema(result_schema);
				const cwd = options.getCwd ? options.getCwd() : process.cwd();
				// The child runs one level deeper than the tool that spawned it. Strip
				// our own tool from its catalog and re-add a depth-incremented copy
				// only if the nesting budget still allows it.
				const childDepth = depth + 1;
				const baseChildTools = buildSubagentToolCatalog(
					options.getAvailableTools(),
					childDepth,
					maxDepth,
					makeTaskTool,
				);

				// Non-blocking spawn: launch detached, return a handle, and let the
				// parent keep working. Async tasks skip the messaging bus (they are
				// fire-and-collect, not interactive) and run on their own controller
				// so they outlive the spawning turn.
				if (op === "spawn") {
					const handle = name?.trim() ? name.trim() : `task-${++asyncTaskCounter}`;
					const controller = new AbortController();
					const entry: PendingTask = {
						handle,
						status: "running",
						startedAt: Date.now(),
						controller,
						promise: Promise.resolve(),
					};
					entry.promise = (async () => {
						try {
							const result = await spawnSubagent(
								{
									registry,
									model,
									modelRegistry: options.modelRegistry,
									availableTools: baseChildTools,
									convertToLlm: options.convertToLlm ?? ((messages) => messages as never),
									permissionChecker: options.permissionChecker,
									skills: options.getSkills?.(),
								},
								{
									prompt,
									model: subModel,
									thinkingLevel: subThinking,
									systemPrompt: system_prompt,
									allowedTools: allowed_tools,
									maxTurns: max_turns,
									signal: controller.signal,
									resultSchema,
									worktree: worktree as boolean | { branch?: string; cleanup?: "auto" | "keep" } | undefined,
									timeoutMs: timeout_ms,
									taskName: handle,
									cwd,
									depth: childDepth,
									inheritSkills: inherit_skills,
								},
							);
							entry.result = formatSpawnResult(result, resultSchema);
							entry.status = "done";
							if (options.onAsyncComplete?.(handle, entry.result, "done")) entry.delivered = true;
						} catch (err) {
							entry.error = err instanceof Error ? err.message : String(err);
							entry.status = "error";
							if (options.onAsyncComplete?.(handle, entry.error, "error")) entry.delivered = true;
						}
					})();
					pending.set(handle, entry);
					return {
						content: [
							{
								type: "text" as const,
								text: `Spawned subagent '${handle}' (non-blocking). Keep working — its result re-injects automatically when it finishes. You may also check task({op:"poll", handles:["${handle}"]}) or collect early with task({op:"join", handles:["${handle}"]}).`,
							},
						],
						isError: false,
						details: { handle, async: true, depth: childDepth },
					};
				}

				// Inter-agent messaging wiring. Reserve a bus id up front so the
				// `message` tool can be bound to it, and attach the live responder
				// once the Agent exists. The id is unregistered in the `finally`
				// below — guaranteed even if spawnSubagent throws before its own
				// teardown runs (e.g. a worktree-setup failure).
				const messagingOn = options.isMessagingEnabled?.() ?? false;
				let childTools = baseChildTools;
				let systemPromptSuffix: string | undefined;
				let onAgentReady: ((agent: Agent) => void) | undefined;
				let messagingId: string | undefined;
				if (messagingOn) {
					const parentId = options.getParentMessagingId?.();
					const selfId = agentMessageBus.reserve(name ?? "Agent", { kind: "sub", parentId });
					messagingId = selfId;
					const timeoutMs = options.getMessagingTimeoutMs?.();
					childTools = [...baseChildTools, createMessageTool(cwd, { selfId, timeoutMs })];
					systemPromptSuffix = messagingPreamble(selfId, parentId);
					onAgentReady = (agent) => {
						agentMessageBus.attachResponder(selfId, makeAgentResponder(agent));
						agentMessageBus.attachDelivery(selfId, makeAgentDelivery(agent));
					};
				}

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
							model: subModel,
							thinkingLevel: subThinking,
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
							systemPromptSuffix,
							onAgentReady,
						},
					);
					const text = formatSpawnResult(result, resultSchema);
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
				} finally {
					// Single, guaranteed teardown for the reserved bus id — covers every
					// spawnSubagent outcome (success, caught failure, or a throw before
					// the agent's own teardown ran). delete is idempotent.
					if (messagingId) agentMessageBus.unregister(messagingId);
				}
			},
		};
	}

	return (pi: ExtensionAPI) => {
		pi.registerTool(makeTaskTool(0));
	};
}
