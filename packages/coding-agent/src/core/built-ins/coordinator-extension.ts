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

import type { Agent, AgentMessage, AgentTool, ThinkingLevel } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import { type Static, type TSchema, Type } from "typebox";
import { isValidThinkingLevel } from "../../cli/args.ts";
import {
	type AgentTypeDef,
	deleteResumeState,
	extractAssistantText,
	listResumeHandlesSync,
	loadAgentTypes,
	loadResumeState,
	SubagentRegistry,
	saveResumeState,
	spawnSubagent,
} from "../coordinator/index.ts";
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
	/** Abort controller for the detached run, so session teardown can stop it. */
	controller: AbortController;
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
			[
				Type.Literal("run"),
				Type.Literal("spawn"),
				Type.Literal("poll"),
				Type.Literal("join"),
				Type.Literal("list"),
				Type.Literal("resume"),
				Type.Literal("continue"),
				Type.Literal("agents"),
			],
			{
				description:
					"run (default, blocking — returns the answer) | spawn (non-blocking — returns a handle so you can keep working) | poll (status of handles) | join (await handles and collect their outputs) | list (active + resumable subagents) | agents (list the reusable agent types loaded from .pit/agents) | resume (continue a subagent cut short by ESC or a network drop, by its `name`/handle, with its transcript intact; pass `prompt` to steer the continuation) | continue (ask a follow-up of a subagent that FINISHED successfully, by its `name`/handle, reusing its transcript; `prompt` required). Use spawn+join to fan out N independent tasks in parallel and gather them.",
			},
		),
	),
	type: Type.Optional(
		Type.String({
			description:
				"Reusable agent type from .pit/agents/<name>.md — applies its system prompt, tools, model, and thinking level as defaults (any field set explicitly here overrides). See this tool's description for the available types.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description:
				"Stable task identifier, also used as the handle for spawn/poll/join/resume and the worktree path. Defaults to the auto-generated subagent id; collisions are auto-resolved.",
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
		Type.String({
			description:
				"The task description for the subagent (required for run/spawn; optional on resume to steer the continuation).",
		}),
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
	max_turns: Type.Optional(Type.Number({ description: "Hard limit on subagent turns. Default: 50." })),
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
 * True when a settled subagent's last turn failed or was aborted — i.e. it
 * stopped with unfinished business (ESC, or a network drop that ended the turn
 * with stopReason "error") and is worth resuming rather than reporting as done.
 */
function agentEndedWithError(agent: Agent): boolean {
	if (agent.state.errorMessage) return true;
	const messages = agent.state.messages;
	const last = messages[messages.length - 1] as AgentMessage | undefined;
	return !!last && last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted");
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

/**
 * Concurrency cap for live subagent runs. Each op:"spawn" launches a detached
 * Promise and op:"run" blocks inline; without a cap, a fan-out of N tasks runs
 * N Agents at once (N parallel model streams + tool I/O). `acquireSlot` queues
 * callers past the cap; `releaseSlot` wakes the oldest waiter. Module-scoped so
 * the budget is shared across every coordinator instance in the process.
 */
const MAX_CONCURRENCY = Number(process.env.PIT_SUBAGENT_MAX_CONCURRENCY) || 4;
let activeSubagents = 0;
const slotWaiters: Array<() => void> = [];

/** Acquire a run slot, awaiting a free one past the cap. Queue time is NOT counted toward task timeouts. */
function acquireSlot(): Promise<void> {
	if (activeSubagents < MAX_CONCURRENCY) {
		activeSubagents++;
		return Promise.resolve();
	}
	return new Promise<void>((resolve) => {
		slotWaiters.push(() => {
			activeSubagents++;
			resolve();
		});
	});
}

/** Release a run slot and wake the oldest waiter, if any. */
function releaseSlot(): void {
	activeSubagents--;
	const next = slotWaiters.shift();
	if (next) next();
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
	/** Fired just before a subagent (run or spawn) starts, so the parent can surface it as live. */
	onSubagentStart?: (handle: string) => void;
	/** Fired once per finished subagent turn with coarse progress (turn N, last tool). */
	onSubagentProgress?: (handle: string, info: { turn: number; lastTool?: string }) => void;
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
	let runTaskCounter = 0;

	// Bound the async-task map: auto-delivered results (delivered=true) are never
	// joined, so without pruning they'd accumulate (handle + result, up to ~24KB
	// each) for the whole session. Evict the OLDEST SETTLED entries past the cap
	// (insertion-order iteration); running tasks are never evicted.
	const PENDING_MAX = 64;
	function prunePending(): void {
		if (pending.size <= PENDING_MAX) return;
		for (const [h, e] of pending) {
			if (pending.size <= PENDING_MAX) break;
			if (e.status !== "running") pending.delete(h);
		}
	}

	// Live Agents whose run was cut short (ESC abort, or a network drop that ended
	// the turn with stopReason "error") and still hold a usable transcript, keyed by
	// handle. op:"resume" re-drives the same Agent so the model continues from where
	// it stopped. In-memory: cleared when the parent session ends.
	const resumable = new Map<string, Agent>();

	// Live Agents from subagents that finished SUCCESSFULLY (no worktree), kept so
	// op:"continue" can issue follow-up prompts on the same transcript instead of
	// re-spawning cold. FIFO-capped at 8 entries to bound memory; cleared with the
	// parent session. Distinct from `resumable` (interrupted/errored runs).
	const continuable = new Map<string, Agent>();
	const CONTINUABLE_MAX = 8;

	/** Record a successfully-finished Agent as continuable, evicting the oldest past the cap. */
	function rememberContinuable(handle: string, agent: Agent): void {
		continuable.set(handle, agent);
		if (continuable.size > CONTINUABLE_MAX) {
			const oldest = continuable.keys().next().value;
			if (oldest !== undefined) continuable.delete(oldest);
		}
	}

	// Mirror continuable's cap so an interrupted-run map can't grow unbounded over a
	// long session: each entry pins a live Agent + its full transcript. Disk-based
	// resume still works for evicted handles (markResumable persists to disk too).
	const RESUMABLE_MAX = 8;

	/** Record an interrupted Agent as resumable, evicting the oldest past the cap. */
	function rememberResumable(handle: string, agent: Agent): void {
		resumable.set(handle, agent);
		if (resumable.size > RESUMABLE_MAX) {
			const oldest = resumable.keys().next().value;
			if (oldest !== undefined && oldest !== handle) resumable.delete(oldest);
		}
	}

	// Reusable agent types from .pit/agents/*.md, loaded once. Spawn via task({type}).
	const agentTypeMap = new Map<string, AgentTypeDef>();
	try {
		for (const t of loadAgentTypes(options.getCwd ? options.getCwd() : process.cwd())) agentTypeMap.set(t.name, t);
	} catch {
		// Agent types are optional and best-effort — never fatal.
	}
	const agentTypeSummary =
		agentTypeMap.size > 0
			? [...agentTypeMap.values()].map((t) => (t.description ? `${t.name} (${t.description})` : t.name)).join("; ")
			: "";

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

	/** Caps a resume/continue body to the subagent output budget, appending a truncation note. */
	function cappedBody(output: string): string {
		const capped = truncateTail(output, { maxBytes: maxOutputBytes, maxLines: SUBAGENT_MAX_LINES });
		return capped.truncated
			? `${capped.content}\n\n[subagent output truncated to ${formatSize(capped.outputBytes)} of ${formatSize(capped.totalBytes)}]`
			: capped.content;
	}

	/**
	 * Wires a fresh ESC (parent abort) to abort the live Agent during a
	 * resume/continue follow-up. Returns a cleanup that removes the listener.
	 */
	function wireAbort(agent: Agent, signal: AbortSignal | undefined): () => void {
		if (!signal) return () => {};
		const onAbort = () => agent.abort();
		if (signal.aborted) agent.abort();
		else signal.addEventListener("abort", onAbort, { once: true });
		return () => signal.removeEventListener("abort", onAbort);
	}

	/**
	 * The dependency object handed to every `spawnSubagent` call — identical across
	 * ops except for the tool catalog (`tools`) and the op-scoped `model`.
	 */
	function makeSpawnDeps(tools: AgentTool[], model: Model<any>) {
		return {
			registry,
			model,
			modelRegistry: options.modelRegistry,
			availableTools: tools,
			convertToLlm: options.convertToLlm ?? ((messages) => messages as never),
			permissionChecker: options.permissionChecker,
			skills: options.getSkills?.(),
		};
	}

	/** op:"list" — summarize tracked subagents and live async handles. */
	function listSubagents(): TaskOpResult {
		const records = registry.list();
		const recLines = records.map((r) => {
			const usage = r.usage ? ` (${r.usage.totalTokens} tok)` : "";
			const err = r.error ? ` (${r.error})` : "";
			return `- ${r.taskName} [${r.status}] turns=${r.turnCount}${usage}${err}`;
		});
		const handleLines = [...pending.values()].map(
			(e) => `- ${e.handle} [${e.status}]${e.error ? ` (${e.error})` : ""}`,
		);
		const sections: string[] = [];
		sections.push(
			records.length ? `Subagents (${records.length}):\n${recLines.join("\n")}` : "No subagents tracked.",
		);
		if (handleLines.length) sections.push(`Async handles (${handleLines.length}):\n${handleLines.join("\n")}`);
		const diskHandles = listResumeHandlesSync(options.getCwd ? options.getCwd() : process.cwd()).filter(
			(h) => !resumable.has(h),
		);
		const resumeLines = [
			...[...resumable.keys()].map((h) => `- ${h}`),
			...diskHandles.map((h) => `- ${h} (persisted)`),
		];
		if (resumeLines.length > 0) {
			sections.push(`Resumable (interrupted — continue with op:"resume"):\n${resumeLines.join("\n")}`);
		}
		const totalTokens = records.reduce((sum, r) => sum + (r.usage ? r.usage.totalTokens : 0), 0);
		sections.push(
			`Slots (process-wide): active=${activeSubagents}, queued=${slotWaiters.length}; totalTokens=${totalTokens}`,
		);
		return {
			content: [{ type: "text" as const, text: sections.join("\n\n") }],
			isError: false,
			details: {
				subagents: records.length,
				asyncHandles: pending.size,
				resumable: resumable.size + diskHandles.length,
				// active/queued are process-wide (module-scoped slot budget shared across coordinator instances).
				active: activeSubagents,
				queued: slotWaiters.length,
				totalTokens,
			},
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
	 * op:"resume" — re-drive a subagent that was interrupted (ESC) or dropped
	 * (network error) mid-task, reusing the SAME live Agent so its transcript is
	 * intact. The dead-end trailing turn is dropped and a continuation prompt
	 * (caller-supplied or a default) is issued. On success the handle is freed; if
	 * it errors again it stays resumable for another attempt.
	 */
	async function resumeHandle(
		handle: string | undefined,
		continuation: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<TaskOpResult> {
		const key = handle?.trim();
		if (!key) {
			return {
				content: [{ type: "text" as const, text: "task: resume needs `name` (the handle to resume)." }],
				isError: true,
				details: undefined,
			};
		}
		const rcwd = options.getCwd ? options.getCwd() : process.cwd();
		const agent = resumable.get(key);
		if (!agent) {
			return await resumeFromDisk(key, continuation, signal);
		}
		// The interrupted run may still be settling (an aborted stream resolves
		// async). Stop it and wait for idle before re-driving the same Agent.
		agent.abort();
		await agent.waitForIdle();
		// Drop a trailing failed/aborted assistant turn so the model resumes from the
		// last real work instead of from a dead-end error message.
		const messages = agent.state.messages;
		const last = messages[messages.length - 1] as AgentMessage | undefined;
		if (last && last.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
			agent.state.messages = messages.slice(0, -1);
		}
		// A fresh ESC during the resume aborts the same Agent (it stays resumable).
		const cleanupAbort = wireAbort(agent, signal);
		const text =
			continuation?.trim() ||
			"You were interrupted before finishing. Continue from where you left off using the conversation above, then give your final answer.";
		// Respect the concurrency cap: a re-driven Agent is a live run like any spawn.
		await acquireSlot();
		try {
			await agent.prompt(text);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: `Subagent resume failed: ${message}` }],
				isError: true,
				details: { handle: key, resumed: true },
			};
		} finally {
			cleanupAbort();
			releaseSlot();
		}
		if (agentEndedWithError(agent)) {
			// Still unfinished — keep it resumable for another attempt.
			return {
				content: [
					{
						type: "text" as const,
						text: `Resume of "${key}" did not complete (it erred again). It remains resumable.`,
					},
				],
				isError: true,
				details: { handle: key, resumed: true, stillResumable: true },
			};
		}
		resumable.delete(key);
		void deleteResumeState(rcwd, key);
		const body = cappedBody(extractAssistantText(agent.state.messages));
		return {
			content: [{ type: "text" as const, text: body }],
			isError: false,
			details: { handle: key, resumed: true },
		};
	}

	/**
	 * op:"continue" — issue a follow-up prompt to a subagent that finished
	 * SUCCESSFULLY, reusing its live Agent so the transcript carries over. Unlike
	 * resume (interrupted/errored runs), the Agent stays continuable afterwards so
	 * multiple follow-ups are possible. `prompt` is required.
	 */
	async function continueHandle(
		handle: string | undefined,
		continuation: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<TaskOpResult> {
		const key = handle?.trim();
		if (!key) {
			return {
				content: [{ type: "text" as const, text: "task: continue needs `name` (the handle to continue)." }],
				isError: true,
				details: undefined,
			};
		}
		const text = continuation?.trim();
		if (!text) {
			return {
				content: [{ type: "text" as const, text: "task: continue needs `prompt` (the follow-up to send)." }],
				isError: true,
				details: undefined,
			};
		}
		const agent = continuable.get(key);
		if (!agent) {
			return {
				content: [
					{
						type: "text" as const,
						text: `task: no continuable subagent "${key}"; it may have been interrupted (use resume) or evicted.`,
					},
				],
				isError: true,
				details: undefined,
			};
		}
		// A fresh ESC during the follow-up aborts this Agent; it stays continuable.
		const cleanupAbort = wireAbort(agent, signal);
		// Respect the concurrency cap: a follow-up is a live run like any spawn.
		await acquireSlot();
		try {
			await agent.prompt(text);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: `Subagent continue failed: ${message}` }],
				isError: true,
				details: { handle: key, continued: true },
			};
		} finally {
			cleanupAbort();
			releaseSlot();
		}
		const body = cappedBody(extractAssistantText(agent.state.messages));
		return {
			content: [{ type: "text" as const, text: body }],
			isError: false,
			details: { handle: key, continued: true },
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
				"Scale the subagent's `model` to the sub-task's complexity (cheap for trivial fan-out, inherit the parent's for hard reasoning) — see the `model` field." +
				(agentTypeSummary ? ` Reusable agent types (use the type field): ${agentTypeSummary}.` : ""),
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
				if (op === "agents") return listAgentTypes();
				if (op === "poll") return pollHandles(p.handles ?? []);
				if (op === "join") return await joinHandles(p.handles ?? []);
				if (op === "resume") return await resumeHandle(p.name ?? p.handles?.[0], p.prompt, signal);
				if (op === "continue") return await continueHandle(p.name ?? p.handles?.[0], p.prompt, signal);

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
				const agentType = p.type?.trim() ? agentTypeMap.get(p.type.trim()) : undefined;
				if (p.type?.trim() && !agentType) {
					return {
						content: [
							{
								type: "text" as const,
								text: `task: unknown agent type "${p.type.trim()}". Available: ${agentTypeSummary || "(none — define one in .pit/agents/<name>.md)"}.`,
							},
						],
						isError: true,
						details: undefined,
					};
				}
				const effSystemPrompt = system_prompt ?? agentType?.systemPrompt;
				const effAllowedTools = allowed_tools ?? agentType?.tools;
				const { model: subModel, thinkingLevel: subThinking } = await resolveSubModel(
					p.model ?? agentType?.model,
					p.thinking_level ?? agentType?.thinkingLevel,
				);
				const resultSchema = coerceResultSchema(result_schema);
				const cwd = options.getCwd ? options.getCwd() : process.cwd();
				// The child runs one level deeper than the tool that spawned it. Strip
				// our own tool from its catalog and re-add a depth-incremented copy
				// only if the nesting budget still allows it.
				const childDepth = depth + 1;
				// Mark a subagent resumable: keep the live Agent for in-session resume
				// (Tier 1) AND persist its transcript to disk so it survives a Pit
				// restart (Tier 2). Callers await the disk write so an interrupted run is
				// durably persisted before its result returns; saveResumeState never throws.
				const markResumable = (handle: string, agent: Agent): Promise<void> => {
					rememberResumable(handle, agent);
					return saveResumeState(cwd, {
						handle,
						messages: agent.state.messages,
						modelId: subModel?.id ?? model.id,
						thinkingLevel: subThinking,
						systemPrompt: effSystemPrompt,
						allowedTools: effAllowedTools,
						cwd,
						depth: childDepth,
						savedAt: Date.now(),
					});
				};
				const baseChildTools = buildSubagentToolCatalog(
					options.getAvailableTools(),
					childDepth,
					maxDepth,
					makeTaskTool,
				);

				// A subagent whose auto-cleanup worktree is removed on settle can't be
				// resumed (its on-disk state is gone); without a worktree, or with
				// worktree cleanup:"keep", the transcript-based resume stays valid.
				const usedAutoWorktree =
					worktree === true ||
					(typeof worktree === "object" &&
						worktree !== null &&
						(worktree as { cleanup?: string }).cleanup !== "keep");

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
						promise: Promise.resolve(),
						controller,
					};
					// Capture the live Agent so a drop/abort leaves a resumable transcript.
					let capturedAgent: Agent | undefined;
					entry.promise = (async () => {
						// Queue past the concurrency cap before doing any work; queue time is
						// not counted against the task timeout (acquire is outside spawnSubagent).
						await acquireSlot();
						try {
							options.onSubagentStart?.(handle);
							const result = await spawnSubagent(makeSpawnDeps(baseChildTools, model), {
								prompt,
								model: subModel,
								thinkingLevel: subThinking,
								systemPrompt: effSystemPrompt,
								allowedTools: effAllowedTools,
								maxTurns: max_turns,
								signal: controller.signal,
								resultSchema,
								worktree: worktree as boolean | { branch?: string; cleanup?: "auto" | "keep" } | undefined,
								timeoutMs: timeout_ms,
								taskName: handle,
								cwd,
								depth: childDepth,
								inheritSkills: inherit_skills,
								onSubagentEvent: (info) => options.onSubagentProgress?.(handle, info),
								onAgentReady: (agent) => {
									capturedAgent = agent;
								},
							});
							// A drop that ended the turn on an error (without throwing) still
							// leaves a resumable transcript — surface it as such, not "done".
							if (capturedAgent && agentEndedWithError(capturedAgent) && !usedAutoWorktree) {
								await markResumable(handle, capturedAgent);
								entry.status = "error";
								entry.error = "interrupted (resumable)";
								const note = `Subagent '${handle}' was interrupted before finishing — resume with task({op:"resume", name:"${handle}"}).`;
								if (options.onAsyncComplete?.(handle, note, "error")) entry.delivered = true;
							} else {
								if (capturedAgent && !usedAutoWorktree) rememberContinuable(handle, capturedAgent);
								entry.result = formatSpawnResult(result, resultSchema);
								entry.status = "done";
								if (options.onAsyncComplete?.(handle, entry.result, "done")) entry.delivered = true;
							}
						} catch (err) {
							entry.error = err instanceof Error ? err.message : String(err);
							entry.status = "error";
							if (capturedAgent && !usedAutoWorktree) await markResumable(handle, capturedAgent);
							const suffix =
								capturedAgent && !usedAutoWorktree ? ` Resume with task({op:"resume", name:"${handle}"}).` : "";
							if (options.onAsyncComplete?.(handle, `${entry.error}${suffix}`, "error")) entry.delivered = true;
						} finally {
							releaseSlot();
						}
					})();
					pending.set(handle, entry);
					prunePending();
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
				const runHandle = name?.trim() ? name.trim() : `run-${++runTaskCounter}`;
				// Capture the live Agent so an interrupted run (ESC / network drop) can be resumed via op:"resume".
				let capturedAgent: Agent | undefined;
				let childTools = baseChildTools;
				let systemPromptSuffix: string | undefined;
				let messagingReady: ((agent: Agent) => void) | undefined;
				let messagingId: string | undefined;
				if (messagingOn) {
					const parentId = options.getParentMessagingId?.();
					const selfId = agentMessageBus.reserve(name ?? "Agent", { kind: "sub", parentId });
					messagingId = selfId;
					const timeoutMs = options.getMessagingTimeoutMs?.();
					childTools = [...baseChildTools, createMessageTool(cwd, { selfId, timeoutMs })];
					systemPromptSuffix = messagingPreamble(selfId, parentId);
					messagingReady = (agent) => {
						agentMessageBus.attachResponder(selfId, makeAgentResponder(agent));
						agentMessageBus.attachDelivery(selfId, makeAgentDelivery(agent));
					};
				}

				// Queue past the concurrency cap before any work; queue time is not
				// counted against the task timeout (acquire is outside spawnSubagent).
				await acquireSlot();
				try {
					options.onSubagentStart?.(runHandle);
					const result = await spawnSubagent(makeSpawnDeps(childTools, model), {
						prompt,
						model: subModel,
						thinkingLevel: subThinking,
						systemPrompt: effSystemPrompt,
						allowedTools: effAllowedTools,
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
						onSubagentEvent: (info) => options.onSubagentProgress?.(runHandle, info),
						onAgentReady: (agent) => {
							capturedAgent = agent;
							messagingReady?.(agent);
						},
					});
					const interrupted = !!capturedAgent && agentEndedWithError(capturedAgent);
					if (interrupted && capturedAgent && !usedAutoWorktree) {
						await markResumable(runHandle, capturedAgent);
					} else {
						resumable.delete(runHandle);
						if (!interrupted && capturedAgent && !usedAutoWorktree) {
							rememberContinuable(runHandle, capturedAgent);
						}
					}
					let text = formatSpawnResult(result, resultSchema);
					if (interrupted) {
						text = `${text}\n\n[subagent ended on an error turn — resume with task({op:"resume", name:"${runHandle}"})]`;
					}
					return {
						content: [{ type: "text" as const, text }],
						isError: interrupted,
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
					if (capturedAgent && !usedAutoWorktree) await markResumable(runHandle, capturedAgent);
					const hint =
						capturedAgent && !usedAutoWorktree ? ` Resume with task({op:"resume", name:"${runHandle}"}).` : "";
					return {
						content: [{ type: "text" as const, text: `Subagent failed: ${message}${hint}` }],
						isError: true,
						details: undefined,
					};
				} finally {
					// Single, guaranteed teardown for the reserved bus id — covers every
					// spawnSubagent outcome (success, caught failure, or a throw before
					// the agent's own teardown ran). delete is idempotent.
					if (messagingId) agentMessageBus.unregister(messagingId);
					// Release the concurrency slot acquired before this try.
					releaseSlot();
				}
			},
		};
	}

	/**
	 * op:"resume" Tier 2 — reopen a subagent whose live Agent is gone (the Pit
	 * process was restarted) from its persisted transcript on disk, re-running the
	 * saved model / tools / system prompt with a continuation prompt. The state
	 * file is removed once the resume completes.
	 */
	async function resumeFromDisk(
		key: string,
		continuation: string | undefined,
		signal: AbortSignal | undefined,
	): Promise<TaskOpResult> {
		const cwd = options.getCwd ? options.getCwd() : process.cwd();
		const state = await loadResumeState(cwd, key);
		if (!state) {
			return {
				content: [
					{
						type: "text" as const,
						text: `task: no resumable subagent for "${key}". Use op:"list" to see resumable handles.`,
					},
				],
				isError: true,
				details: undefined,
			};
		}
		const model = options.getParentModel();
		if (!model) {
			return {
				content: [{ type: "text" as const, text: "No model available to resume subagent." }],
				isError: true,
				details: undefined,
			};
		}
		let subModel = model;
		if (state.modelId) {
			try {
				const available = await options.modelRegistry.getAvailable();
				const found = available.find((m) => m.id === state.modelId);
				if (found) subModel = found;
			} catch {
				// Keep the parent model if the saved one can't be resolved.
			}
		}
		// Drop a trailing failed/aborted assistant turn from the seed transcript.
		const seed = [...state.messages];
		const tail = seed[seed.length - 1] as AgentMessage | undefined;
		if (tail && tail.role === "assistant" && (tail.stopReason === "error" || tail.stopReason === "aborted")) {
			seed.pop();
		}
		const childTools = buildSubagentToolCatalog(options.getAvailableTools(), state.depth, maxDepth, makeTaskTool);
		const text =
			continuation?.trim() ||
			"You were interrupted before finishing. Continue from where you left off using the conversation above, then give your final answer.";
		// Respect the concurrency cap: a disk-resumed run is a live spawn.
		await acquireSlot();
		try {
			const result = await spawnSubagent(makeSpawnDeps(childTools, model), {
				prompt: text,
				initialMessages: seed,
				model: subModel,
				thinkingLevel: state.thinkingLevel as ThinkingLevel | undefined,
				systemPrompt: state.systemPrompt,
				allowedTools: state.allowedTools,
				signal,
				cwd: state.cwd,
				depth: state.depth,
				taskName: key,
			});
			await deleteResumeState(cwd, key);
			const out = formatSpawnResult(result, undefined);
			return {
				content: [{ type: "text" as const, text: out }],
				isError: false,
				details: { handle: key, resumed: true, fromDisk: true },
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				content: [{ type: "text" as const, text: `Subagent resume failed: ${message}` }],
				isError: true,
				details: { handle: key, resumed: true },
			};
		} finally {
			releaseSlot();
		}
	}

	/** op:"agents" — list the reusable agent types loaded from .pit/agents, with origin. */
	function listAgentTypes(): TaskOpResult {
		const types = [...agentTypeMap.values()];
		if (types.length === 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: "No agent types loaded. Define one in .pit/agents/<name>.md (project) or ~/.pit/agents/ (user).",
					},
				],
				isError: false,
				details: { agentTypes: 0 },
			};
		}
		const lines = types.map((t) => {
			const attrs: string[] = [];
			if (t.tools) attrs.push(`tools: ${t.tools.join(", ")}`);
			if (t.model) attrs.push(`model: ${t.model}`);
			if (t.thinkingLevel) attrs.push(`thinking: ${t.thinkingLevel}`);
			const meta = attrs.length > 0 ? ` (${attrs.join("; ")})` : "";
			const desc = t.description ? ` — ${t.description}` : "";
			return `- ${t.name} [${t.source}]${desc}${meta}`;
		});
		return {
			content: [{ type: "text" as const, text: `Agent types (${types.length}):\n${lines.join("\n")}` }],
			isError: false,
			details: { agentTypes: types.length },
		};
	}

	return (pi: ExtensionAPI) => {
		pi.registerTool(makeTaskTool(0));
		// On session teardown (/new, /fork, switchSession, /quit) abort any detached
		// spawns so they stop burning tokens and writing to a now-orphaned worktree.
		// Worktree paths are UUID-unique (no cross-session corruption), so after a short
		// grace we stop blocking teardown even if a queued spawn hasn't settled yet.
		// pi.on is optional-called: test stubs pass { registerTool } without `.on`.
		pi.on?.("session_shutdown", async () => {
			const inflight: Array<Promise<void>> = [];
			for (const e of pending.values()) {
				if (e.status === "running") {
					e.controller.abort(new Error("aborted: session teardown"));
					inflight.push(e.promise.catch(() => {}));
				}
			}
			if (inflight.length === 0) return;
			const grace = new Promise<void>((r) => setTimeout(r, 1500));
			await Promise.race([Promise.all(inflight), grace]);
		});
	};
}
