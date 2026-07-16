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
	brandCoordinatorTool,
	COORDINATOR_TOOL_BRAND,
	COORDINATOR_TOOL_NAMES,
	isCoordinatorTool,
} from "../coordinator/brand.ts";
import {
	type AgentTypeDef,
	createSubagentOutputStore,
	deleteResumeState,
	extractAssistantText,
	type GateDetails,
	getSubagentErrorUsage,
	listResumeHandlesSync,
	loadAgentTypes,
	loadResumeState,
	type ParallelTaskResult,
	retargetToolsForWorktree,
	runFanout,
	runWithAcceptance,
	SubagentRegistry,
	saveResumeState,
	slotStats,
	spawnAll,
	spawnSubagent,
	withoutLease,
	withRunSlot,
	yieldRunSlotWhile,
} from "../coordinator/index.ts";
import type { SpawnSubagentResult, SubagentStatus, SubagentUsage } from "../coordinator/types.ts";
import type { ExtensionAPI, ToolDefinition } from "../extensions/types.ts";
import { agentMessageBus, makeAgentDelivery, makeAgentResponder } from "../messaging/index.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { parseModelPattern } from "../model-resolver.ts";
import type { Skill } from "../skills.ts";
import type { TokenBudgetGovernor } from "../token-governor.ts";
import { aggregateAssistantUsage, mergeSubagentUsage } from "../token-usage.ts";
import { withAgentScope } from "../tools/hindsight-scope.ts";
import { createMessageTool } from "../tools/message.ts";
import { formatSize, RECALL_OUTPUT_CAP_BYTES, truncateHeadTail } from "../tools/truncate.ts";

/**
 * Cross-harness aliases for the built-in agent types. Frontier models trained on
 * other harnesses reach for Claude Code's stock names (`general-purpose`,
 * `code-reviewer`); the Pit builtins are `general` / `review`. Without this
 * bridge a `task({type:"general-purpose"})` fails with "unknown agent type" once
 * per session and never becomes a learned rule. Keys are lowercased.
 */
const AGENT_TYPE_ALIASES: Record<string, string> = {
	"general-purpose": "general",
	"code-reviewer": "review",
};

/**
 * Resolve a raw `task` type param to a loaded agent type, tolerant of case and
 * the cross-harness aliases above. Tries the exact name first (so a custom
 * `.pit/agents/<Name>.md` with mixed case still resolves byte-for-byte), then
 * folds case and applies the alias map, then scans case-insensitively for a
 * custom type declared with different casing. Returns undefined when nothing
 * matches so the caller still errors with the available-types list.
 */
function resolveAgentType(map: Map<string, AgentTypeDef>, rawType: string | undefined): AgentTypeDef | undefined {
	const trimmed = rawType?.trim();
	if (!trimmed) return undefined;
	const direct = map.get(trimmed);
	if (direct) return direct;
	const lower = trimmed.toLowerCase();
	const aliased = AGENT_TYPE_ALIASES[lower] ?? lower;
	const byAlias = map.get(aliased);
	if (byAlias) return byAlias;
	for (const [key, value] of map) {
		if (key.toLowerCase() === aliased) return value;
	}
	return undefined;
}

/** A subagent launched via `task({op:"spawn"})` — runs detached, collected later via poll/join. */
interface PendingTask {
	handle: string;
	status: "running" | "done" | "error";
	promise: Promise<void>;
	/** Abort controller for the detached run, so session teardown / Esc can stop it. */
	controller: AbortController;
	result?: string;
	error?: string;
	/** True once the result was re-injected into the chat, so poll/join don't repeat the payload. */
	delivered?: boolean;
	turns?: number;
	totalTokens?: number;
}

/** Shared result shape for every `task` op so the inferred tool `details` type unifies. */
type TaskOpResult = {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
	details: Record<string, unknown> | undefined;
};

/** Lifecycle/UI callbacks are telemetry: never let them alter task semantics. */
function safeCallback<T>(fn: () => T, fallback: T): T {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

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

/**
 * Op name for reading a settled subagent's integral output. Shared as a single
 * constant so the schema literal (below), the tool description, and the recovery
 * pointer text can never drift apart (lesson M18: placeholder + description +
 * schema bound to one source of truth, guarded by a consistency test). Declared
 * before `taskSchema` because the schema literal consumes it at module load.
 */
export const SUBAGENT_READ_OP = "read" as const;

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
				Type.Literal(SUBAGENT_READ_OP),
			],
			{
				description:
					"run (default, blocking — returns the answer) | spawn (non-blocking — returns a handle so you can keep working) | poll (status of handles) | join (await handles and collect their outputs) | list (active + resumable subagents) | agents (list the reusable agent types loaded from .pit/agents) | resume (continue a subagent cut short by ESC or a network drop, by its `name`/handle, with its transcript intact; pass `prompt` to steer the continuation) | continue (ask a follow-up of a subagent that FINISHED successfully, by its `name`/handle, reusing its transcript; `prompt` required) | read (fetch a settled subagent's INTEGRAL output by its `name`/handle — the join payload is only a small head+tail digest, so use this to recover the elided middle instead of re-spawning). Use spawn+join to fan out N independent tasks in parallel and gather them.",
			},
		),
	),
	type: Type.Optional(
		Type.String({
			description:
				"Reusable agent type from .pit/agents/<name>.md — applies its system prompt, tools, model, and thinking level as defaults (any field set explicitly here overrides). Built-in types: explore, plan, review, general (aliases general-purpose->general, code-reviewer->review; case-insensitive). Project/user types come from .pit/agents/<name>.md. See this tool's description for the full list.",
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
	acceptance: Type.Optional(
		Type.Object({
			criteria: Type.Optional(
				Type.String({ description: "Semantic acceptance bar, judged by a fresh judge subagent." }),
			),
			check: Type.Optional(
				Type.String({ description: "Shell command; passes iff exit code 0 (permission-gated)." }),
			),
			max_attempts: Type.Optional(Type.Number({ description: "Worker attempts including the first; default 2." })),
		}),
	),
});

type TaskInput = Static<typeof taskSchema>;

/** Name of the coordinator-spawned task tool. Stripped/rebuilt per nesting level. */
const TASK_TOOL_NAME = "task";
const PARALLEL_TOOL_NAME = "parallel";
const FANOUT_TOOL_NAME = "fanout";

export { COORDINATOR_TOOL_BRAND, COORDINATOR_TOOL_NAMES, isCoordinatorTool };

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
 * Default byte cap on the DIGEST of a subagent's final output as it lands in the
 * parent's context (N7). The parent no longer carries a 24KB tail permanently:
 * it gets a small head+tail digest (4KB default) plus a pointer to recover the
 * integral output via op:"read". The full text is persisted to disk (and stays
 * on the in-memory registry) so nothing is lost. `PIT_SUBAGENT_MAX_BYTES` still
 * overrides this inline cap — same env var, smaller default.
 */
const DEFAULT_SUBAGENT_DIGEST_BYTES = 4 * 1024; // 4KB

/** Resolves the inline digest cap, honoring the `PIT_SUBAGENT_MAX_BYTES` override. */
export function resolveSubagentMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env.PIT_SUBAGENT_MAX_BYTES;
	if (raw === undefined || raw.trim() === "") return DEFAULT_SUBAGENT_DIGEST_BYTES;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SUBAGENT_DIGEST_BYTES;
	return parsed;
}

/**
 * The recovery pointer appended to a truncated subagent digest. Cites
 * {@link SUBAGENT_READ_OP} exactly so the model is told the precise op + handle
 * to fetch the untruncated output. Exported for the M18 consistency test.
 */
export function subagentReadPointer(handle: string, totalBytes: number): string {
	return `[digest only — full ${formatSize(totalBytes)} output persisted; recover it with task({op:"${SUBAGENT_READ_OP}", name:"${handle}"})]`;
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
	makeCoordinatorTools: (depth: number) => AgentTool[],
): AgentTool[] {
	const base = parentTools.filter((tool) => !isCoordinatorTool(tool));
	if (childDepth < maxDepth) {
		return [...base, ...makeCoordinatorTools(childDepth)];
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

// Concurrency is now enforced at the single chokepoint inside `spawnSubagent`
// (see coordinator/slots.ts): every live Agent — blocking runs, detached
// spawns, parallel/fanout children, acceptance judges, resume/continue
// re-drives — costs one process-wide slot. This extension only needs the
// stats view (op:"list") and the two wrappers for paths that re-drive a live
// Agent directly (resume/continue) or launch detached work (op:"spawn").

export interface CoordinatorExtensionOptions {
	modelRegistry: ModelRegistry;
	/** Parent's permission checker — gates every subagent tool call (headless = ask→deny). */
	permissionChecker?: import("../permissions/index.ts").PermissionChecker;
	/** Provider that returns the parent's currently active model. */
	getParentModel: () => import("@pit/ai").Model<any> | undefined;
	/** Provider that returns the parent's full AgentTool catalog at call time. */
	getAvailableTools: () => AgentTool[];
	/**
	 * Session-aware worktree rebinder. The AgentSession supplies one that
	 * preserves configured shell/search/LSP options; direct SDK callers fall
	 * back to the native default in spawnSubagent.
	 */
	retargetToolsForCwd?: (tools: AgentTool[], cwd: string) => AgentTool[];
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
	 * op:"join" would return. By default the parent only emits a status line and
	 * leaves the result to be collected via join/poll (returns false). With
	 * PIT_ASYNC_REINJECT it re-injects the result into the chat (returns true), so
	 * poll/join won't repeat it. Absent → spawn stays poll-only.
	 */
	onAsyncComplete?: (
		handle: string,
		text: string,
		status: "done" | "error",
		meta?: { turns?: number; totalTokens?: number },
	) => boolean;
	/** Fired just before a subagent (run or spawn) starts, so the parent can surface it as live. */
	onSubagentStart?: (handle: string) => void;
	/** Fired once per finished subagent turn with coarse progress (turn N, last tool). */
	onSubagentProgress?: (handle: string, info: { turn: number; lastTool?: string }) => void;
	/** Fired when a blocking run/resume/continue settles (turns/tokens for the TUI). */
	onSubagentComplete?: (
		handle: string,
		status: "done" | "error",
		meta?: { turns?: number; totalTokens?: number },
	) => void;
	/** Called once with a function that aborts all detached op:"spawn" controllers (Esc). */
	registerAbortDetached?: (abortFn: () => void) => void;
	/** True when subagent memory should be scoped by agent type (default-on setting). */
	isScopedHindsightEnabled?: () => boolean;
	/** Unified token budget governor — gates spawn and records subagent spend. */
	getTokenGovernor?: () => TokenBudgetGovernor | undefined;
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
	// N7: full (integral) output of each settled subagent, persisted to disk so
	// op:"read" can recover it after the inline digest. The registry stays the
	// primary in-memory cache; this is the recovery + RAM-relief layer. Disposed
	// on session teardown.
	const outputStore = createSubagentOutputStore();
	const scopedHindsightEnabled = () => {
		if (process.env.PIT_NO_SCOPED_HINDSIGHT === "1") return false;
		return options.isScopedHindsightEnabled?.() ?? true;
	};

	// Detached subagents launched via op:"spawn", keyed by handle. Collected via
	// op:"poll"/"join"; a joined handle is freed once settled.
	const pending = new Map<string, PendingTask>();
	let asyncTaskCounter = 0;
	let runTaskCounter = 0;

	// Bound the async-task map: auto-delivered results (delivered=true) are never
	// joined, so without pruning they'd accumulate (handle + result, up to ~24KB
	// each) for the whole session. Evict the OLDEST COLLECTED entries past the cap
	// (insertion-order iteration). Running tasks are never evicted, and neither is a
	// settled-but-undelivered result: by default async re-injection is OFF, so
	// onAsyncComplete returns false and a finished task stays
	// `status==="done" && !delivered` and the model is expected to poll/join it.
	// Dropping such an entry would make its output unreachable (poll/join would then
	// report `unknown handle`). Errored entries are collectible-once but safe to drop
	// under pressure since their payload is small.
	const PENDING_MAX = 64;
	function prunePending(): void {
		if (pending.size <= PENDING_MAX) return;
		for (const [h, e] of pending) {
			if (pending.size <= PENDING_MAX) break;
			const collectible = e.status === "done" && !e.delivered;
			if (e.status !== "running" && !collectible) pending.delete(h);
		}
	}

	interface LiveAgentRecord {
		agent: Agent;
		recordId: string;
	}

	// Live Agents whose run was cut short (ESC abort, or a network drop that ended
	// the turn with stopReason "error") and still hold a usable transcript, keyed by
	// public handle. The canonical registry id travels with the Agent because raw
	// requested handles may collide and resolve to a different taskName.
	const resumable = new Map<string, LiveAgentRecord>();

	// Live Agents from subagents that finished SUCCESSFULLY (no worktree), kept so
	// op:"continue" can issue follow-up prompts on the same transcript instead of
	// re-spawning cold. FIFO-capped at 8 entries to bound memory; cleared with the
	// parent session. Distinct from `resumable` (interrupted/errored runs).
	const continuable = new Map<string, LiveAgentRecord>();
	const CONTINUABLE_MAX = 8;

	/** Record a successfully-finished Agent as continuable, evicting the oldest past the cap. */
	function rememberContinuable(handle: string, agent: Agent, recordId: string): void {
		continuable.set(handle, { agent, recordId });
		if (continuable.size > CONTINUABLE_MAX) {
			const oldest = continuable.keys().next().value;
			if (oldest !== undefined) continuable.delete(oldest);
		}
	}

	function completeMetaFromUsage(
		turns: number | undefined,
		usage: SubagentUsage | undefined,
	): { turns?: number; totalTokens?: number } {
		return {
			turns,
			totalTokens: usage?.totalTokens,
		};
	}

	function emitBlockingComplete(
		handle: string,
		status: "done" | "error",
		turns?: number,
		usage?: SubagentUsage,
	): void {
		safeCallback(() => options.onSubagentComplete?.(handle, status, completeMetaFromUsage(turns, usage)), undefined);
	}

	function abortAllPending(reason = "aborted: parent interrupt"): void {
		for (const e of pending.values()) {
			if (e.status === "running") {
				e.controller.abort(new Error(reason));
			}
		}
	}
	options.registerAbortDetached?.(() => abortAllPending());

	// Mirror continuable's cap so an interrupted-run map can't grow unbounded over a
	// long session: each entry pins a live Agent + its full transcript. Disk-based
	// resume still works for evicted handles (markResumable persists to disk too).
	const RESUMABLE_MAX = 8;

	/** Record an interrupted Agent as resumable, evicting the oldest past the cap. */
	function rememberResumable(handle: string, agent: Agent, recordId: string): void {
		resumable.set(handle, { agent, recordId });
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

	/**
	 * The inline payload the parent sees for a settled subagent (N7): a head+tail
	 * DIGEST of the full text capped at `maxOutputBytes` (4KB default), plus a
	 * pointer citing op:"read" + the handle to recover the integral output. When
	 * the text already fits the cap the digest IS the full output, so no pointer
	 * is appended (nothing to recover). `readHandle` is the name the model passes
	 * back to op:"read" — the same key the full output is persisted under.
	 */
	function digestWithPointer(rawText: string, readHandle: string): string {
		const digest = truncateHeadTail(rawText, { maxBytes: maxOutputBytes });
		if (!digest.truncated) return digest.content;
		return `${digest.content}\n\n${subagentReadPointer(readHandle, digest.totalBytes)} (inline digest capped at ${formatSize(maxOutputBytes)}; FIFO continue/resume memory holds at most ${CONTINUABLE_MAX} live Agents)`;
	}

	/** Formats a settled subagent result into the digest + recovery pointer the parent sees. */
	function formatSpawnResult(
		result: SpawnSubagentResult,
		resultSchema: TSchema | undefined,
		readHandle: string,
	): string {
		const rawText =
			resultSchema && result.value !== undefined ? JSON.stringify(result.value, null, 2) : result.output;
		return digestWithPointer(rawText, readHandle);
	}

	/**
	 * op:"read" — return a settled subagent's INTEGRAL output by its handle. Prefers
	 * the in-memory registry record (primary cache, keyed by taskName) and falls
	 * back to the on-disk copy — which survives registry eviction and resume/
	 * continue runs (those re-drive a live Agent and never write a registry record).
	 *
	 * The integral text is returned as-is; the task tool carries an `outputCap` of
	 * RECALL_OUTPUT_CAP_BYTES (96KB, head+tail) so `wrapToolDefinition` bounds it at
	 * the wrap layer exactly like `recall_tool_output` — a giant output can't flood
	 * the parent, yet its head AND tail both survive (a head-only re-cut would drop
	 * the tail the model recovered it for).
	 */
	function readOutput(handle: string | undefined): TaskOpResult {
		const key = handle?.trim();
		if (!key) {
			return {
				content: [
					{ type: "text" as const, text: `task: ${SUBAGENT_READ_OP} needs \`name\` (the task handle to read).` },
				],
				isError: true,
				details: undefined,
			};
		}
		const record = registry.list().find((r) => r.taskName === key);
		const full = record?.output ?? outputStore.get(key);
		if (full === undefined) {
			return {
				content: [
					{
						type: "text" as const,
						text: `task: no stored output for "${key}". Use op:"list" to see tracked subagents.`,
					},
				],
				isError: true,
				details: undefined,
			};
		}
		return {
			content: [{ type: "text" as const, text: full }],
			isError: false,
			details: { handle: key, bytes: Buffer.byteLength(full, "utf8") },
		};
	}

	function spawnBudgetBlock(): TaskOpResult | undefined {
		const governor = options.getTokenGovernor?.();
		if (!governor) return undefined;
		const gate = governor.evaluateSpawn();
		if (gate.allowed) return undefined;
		return {
			content: [{ type: "text" as const, text: gate.reason ?? "Token budget blocks subagent spawn." }],
			isError: true,
			details: undefined,
		};
	}

	function recordSubagentSpend(usage: SubagentUsage | undefined): void {
		options.getTokenGovernor?.()?.recordSubagent(usage);
	}

	interface DirectAgentRecordBaseline {
		id: string;
		turnCount: number;
		usage: SubagentUsage | undefined;
	}

	/** Snapshot registry accounting before a live Agent is re-driven. */
	function directAgentRecordBaseline(recordId: string): DirectAgentRecordBaseline | undefined {
		const record = registry.get(recordId);
		if (!record) return undefined;
		return {
			id: record.id,
			turnCount: record.turnCount,
			usage: record.usage ? { ...record.usage } : undefined,
		};
	}

	/**
	 * Charge and merge only the assistant messages appended by one in-memory
	 * resume/continue prompt. The pre-prompt registry snapshot prevents the live
	 * Agent's original spawn subscription from making this merge double-count the
	 * same turn in the retained record.
	 */
	function accountDirectAgentSettlement(
		agent: Agent,
		messageBoundary: number,
		recordBaseline: DirectAgentRecordBaseline | undefined,
		status: SubagentStatus,
		error: string | undefined,
	): void {
		const appended = agent.state.messages.slice(messageBoundary);
		const assistantTurns = appended.reduce((count, message) => count + (message.role === "assistant" ? 1 : 0), 0);
		const usageDelta = aggregateAssistantUsage(appended);
		// Exactly one ledger call per settled prompt. TokenBudgetGovernor treats a
		// zero-token delta as a no-op.
		recordSubagentSpend(usageDelta);
		if (!recordBaseline) return;
		const record = registry.get(recordBaseline.id);
		if (!record) return;
		registry.update(record.id, {
			turnCount: recordBaseline.turnCount + assistantTurns,
			usage: mergeSubagentUsage(recordBaseline.usage, usageDelta),
			status,
			endedAt: Date.now(),
			error: status === "completed" ? undefined : error,
		});
	}

	function directSettlementStatus(
		agent: Agent,
		promptFailed: boolean,
		signal: AbortSignal | undefined,
	): SubagentStatus {
		const last = agent.state.messages[agent.state.messages.length - 1] as AgentMessage | undefined;
		if (signal?.aborted || (last?.role === "assistant" && last.stopReason === "aborted")) return "cancelled";
		if (promptFailed || agentEndedWithError(agent)) return "failed";
		return "completed";
	}

	function directSettlementError(agent: Agent, promptError: unknown): string | undefined {
		if (promptError !== undefined) return promptError instanceof Error ? promptError.message : String(promptError);
		const last = agent.state.messages[agent.state.messages.length - 1] as AgentMessage | undefined;
		if (last?.role === "assistant") return last.errorMessage;
		return agent.state.errorMessage;
	}

	/**
	 * Digests a resume/continue body to the inline budget with a recovery pointer,
	 * and persists the integral output so op:"read" can recover it. resume/continue
	 * re-drive a live Agent (no registry record), so the disk copy is the ONLY way
	 * their full output stays retrievable.
	 */
	function cappedBody(output: string, readHandle: string): string {
		outputStore.put(readHandle, output);
		return digestWithPointer(output, readHandle);
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
			// Worktree spawns rebuild their cwd-sensitive tools bound to the worktree
			// so the isolation is real. Prefer the session-aware rebinder (preserves
			// configured shell/search/LSP options); the native fallback remains
			// fail-closed for SDK/direct callers.
			retargetToolsForCwd: options.retargetToolsForCwd ?? retargetToolsForWorktree,
		};
	}

	/** Resolve the full reusable-agent preset for one parallel/fanout child. */
	async function resolveChildPreset(
		raw: { type?: string; model?: string; thinking_level?: string; allowed_tools?: string[] },
		childTools: AgentTool[],
		cwd: string,
	): Promise<
		| { error: string }
		| {
				model: Model<any> | undefined;
				thinkingLevel: ThinkingLevel | undefined;
				systemPrompt: string | undefined;
				allowedTools: string[] | undefined;
				tools: AgentTool[];
		  }
	> {
		const agentType = resolveAgentType(agentTypeMap, raw.type);
		if (raw.type?.trim() && !agentType) {
			return {
				error: `unknown agent type "${raw.type.trim()}". Available: ${agentTypeSummary || "(none — define one in .pit/agents/<name>.md)"}.`,
			};
		}
		const scope = scopedHindsightEnabled() ? agentType?.name : undefined;
		const autoAddMemory = scopedHindsightEnabled() && agentType?.memory === true;
		const baseAllowed = raw.allowed_tools ?? agentType?.tools;
		const allowedTools =
			autoAddMemory && baseAllowed
				? Array.from(new Set([...baseAllowed, "recall", "retain", "reflect"]))
				: baseAllowed;
		const resolved = await resolveSubModel(
			raw.model ?? agentType?.model,
			raw.thinking_level ?? agentType?.thinkingLevel,
		);
		return {
			...resolved,
			systemPrompt: agentType?.systemPrompt,
			allowedTools,
			tools: withAgentScope([...childTools], scope, cwd, autoAddMemory),
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
		const continueLines = [...continuable.keys()].map((h) => `- ${h}`);
		if (continueLines.length > 0) {
			sections.push(
				`Continuable (follow-up with op:"continue"; FIFO cap ${CONTINUABLE_MAX}):\n${continueLines.join("\n")}`,
			);
		}
		const totalTokens = records.reduce((sum, r) => sum + (r.usage ? r.usage.totalTokens : 0), 0);
		const slots = slotStats();
		sections.push(`Slots (process-wide): active=${slots.active}, queued=${slots.queued}; totalTokens=${totalTokens}`);
		return {
			content: [{ type: "text" as const, text: sections.join("\n\n") }],
			isError: false,
			details: {
				subagents: records.length,
				asyncHandles: pending.size,
				resumable: resumable.size + diskHandles.length,
				continuable: continuable.size,
				// active/queued are process-wide (slot budget shared across coordinator instances).
				active: slots.active,
				queued: slots.queued,
				totalTokens,
			},
		};
	}

	/** op:"poll" — non-blocking status of the given async handles. */
	function pollHandles(rawHandles: string[]): TaskOpResult {
		if (rawHandles.length === 0) {
			return {
				content: [{ type: "text" as const, text: "task: poll needs `handles`." }],
				isError: true,
				details: undefined,
			};
		}
		const handles = [...new Set(rawHandles)];
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
	async function joinHandles(rawHandles: string[], signal?: AbortSignal): Promise<TaskOpResult> {
		if (rawHandles.length === 0) {
			return {
				content: [{ type: "text" as const, text: "task: join needs `handles`." }],
				isError: true,
				details: undefined,
			};
		}
		const handles = [...new Set(rawHandles)];
		const entries = handles.map((h) => pending.get(h)).filter((e): e is PendingTask => e !== undefined);
		// Snapshot the resolved entries (keyed by handle) BEFORE awaiting. A concurrent
		// op:spawn can call prunePending() while we're suspended on the await, which evicts
		// the oldest SETTLED entries — including a just-joined one — from `pending`. Reading
		// back via `pending.get(h)` would then report a successfully-completed task as
		// `(unknown handle)` and silently drop its result. The snapshot holds the same live
		// entry objects, whose status/result/error mutate in place, so it reflects the final
		// settled state once the await resolves.
		const snapshot = new Map(entries.map((e) => [e.handle, e]));
		await yieldRunSlotWhile(signal, () => Promise.allSettled(entries.map((e) => e.promise)));
		const parts = handles.map((h) => {
			const e = snapshot.get(h) ?? pending.get(h);
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
		const live = resumable.get(key);
		if (!live) {
			return await resumeFromDisk(key, continuation, signal);
		}
		const { agent, recordId } = live;
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
		// Capture the boundary only after removing the failed tail: that discarded
		// response was already charged by the original run and must not be charged
		// again by this resume.
		const messageBoundary = agent.state.messages.length;
		const recordBaseline = directAgentRecordBaseline(recordId);
		// A fresh ESC during the resume aborts the same Agent (it stays resumable).
		const cleanupAbort = wireAbort(agent, signal);
		const text =
			continuation?.trim() ||
			"You were interrupted before finishing. Continue from where you left off using the conversation above, then give your final answer.";
		// Respect the concurrency budget: a re-driven Agent is a live run like any
		// spawn. withRunSlot also yields/reacquires an enclosing lease, so a resume
		// issued from inside a nested subagent's turn can't deadlock the budget.
		let promptFailed = false;
		let promptError: unknown;
		try {
			await withRunSlot(signal, () => agent.prompt(text));
		} catch (err) {
			promptFailed = true;
			promptError = err;
		} finally {
			cleanupAbort();
			accountDirectAgentSettlement(
				agent,
				messageBoundary,
				recordBaseline,
				directSettlementStatus(agent, promptFailed, signal),
				directSettlementError(agent, promptError),
			);
		}
		if (promptFailed) {
			const message = promptError instanceof Error ? promptError.message : String(promptError);
			return {
				content: [{ type: "text" as const, text: `Subagent resume failed: ${message}` }],
				isError: true,
				details: { handle: key, resumed: true },
			};
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
		await deleteResumeState(rcwd, key);
		const body = cappedBody(extractAssistantText(agent.state.messages), key);
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
		const live = continuable.get(key);
		if (!live) {
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
		const { agent, recordId } = live;
		const messageBoundary = agent.state.messages.length;
		const recordBaseline = directAgentRecordBaseline(recordId);
		// A fresh ESC during the follow-up aborts this Agent; it stays continuable.
		const cleanupAbort = wireAbort(agent, signal);
		// Respect the concurrency budget: a follow-up is a live run like any spawn.
		let promptFailed = false;
		let promptError: unknown;
		try {
			await withRunSlot(signal, () => agent.prompt(text));
		} catch (err) {
			promptFailed = true;
			promptError = err;
		} finally {
			cleanupAbort();
			accountDirectAgentSettlement(
				agent,
				messageBoundary,
				recordBaseline,
				directSettlementStatus(agent, promptFailed, signal),
				directSettlementError(agent, promptError),
			);
		}
		if (promptFailed) {
			const message = promptError instanceof Error ? promptError.message : String(promptError);
			return {
				content: [{ type: "text" as const, text: `Subagent continue failed: ${message}` }],
				isError: true,
				details: { handle: key, continued: true },
			};
		}
		const body = cappedBody(extractAssistantText(agent.state.messages), key);
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
		return brandCoordinatorTool({
			name: TASK_TOOL_NAME,
			label: TASK_TOOL_NAME,
			description:
				"Spawn a focused subagent to complete an isolated sub-task and return its final answer. " +
				"Use this to delegate research, file exploration, or repetitive checks without polluting the main conversation. " +
				"Pass `result_schema` for structured output, or `worktree: true` to run in an isolated git worktree. " +
				`The run/join payload is a compact head+tail digest; call op:"${SUBAGENT_READ_OP}" with the task's name to recover a settled subagent's integral output without re-spawning. ` +
				"Scale the subagent's `model` to the sub-task's complexity (cheap for trivial fan-out, inherit the parent's for hard reasoning) — see the `model` field." +
				(agentTypeSummary ? ` Reusable agent types (use the type field): ${agentTypeSummary}.` : ""),
			promptSnippet:
				"Spawn a subagent to handle an isolated sub-task. Supports structured output via result_schema and isolated git worktrees via worktree.",
			parameters: taskSchema,
			sideEffect: "agent",
			// op:"read" can return up to RECALL_OUTPUT_CAP_BYTES (96KB) of integral
			// output. Without a per-tool cap, wrapToolDefinition's generic 64KB
			// HEAD-ONLY safety net would re-cut a large read result and drop its tail.
			// Mirror recall_tool_output: raise this tool's ceiling to 96KB and keep
			// head + tail. Inert for every other op — their payloads (4KB digests,
			// status lines) sit well under the cap.
			outputCap: { maxBytes: RECALL_OUTPUT_CAP_BYTES, mode: "headTail" as const },
			// `params` is typed `unknown`, not `TaskInput`: this tool flows through the
			// shared `(depth) => AgentTool` factory, whose `execute` is contravariantly
			// typed against the erased base schema. A narrower param breaks assignability.
			async execute(_id: string, params: unknown, signal?: AbortSignal): Promise<TaskOpResult> {
				const p = params as TaskInput;
				const op = p.op ?? "run";

				if (op === "list") return listSubagents();
				if (op === "agents") return listAgentTypes();
				if (op === SUBAGENT_READ_OP) return readOutput(p.name ?? p.handles?.[0]);
				if (op === "poll") return pollHandles(p.handles ?? []);
				if (op === "join") return await joinHandles(p.handles ?? [], signal);
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
					acceptance,
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
				const budgetBlocked = spawnBudgetBlock();
				if (budgetBlocked) return budgetBlocked;
				const agentType = resolveAgentType(agentTypeMap, p.type);
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
				const hindsightScope = scopedHindsightEnabled() ? agentType?.name : undefined;
				const autoAddMemory = scopedHindsightEnabled() && agentType?.memory === true;
				const effAllowedToolsScoped =
					autoAddMemory && effAllowedTools
						? Array.from(new Set([...effAllowedTools, "recall", "retain", "reflect"]))
						: effAllowedTools;
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
				// A kept worktree becomes the child's effective cwd. Persist that path
				// so a Tier-2 disk resume rebinds tools to the same isolated checkout
				// instead of silently falling back to the parent tree.
				let effectiveChildCwd = cwd;
				// Mark a subagent resumable: keep the live Agent for in-session resume
				// (Tier 1) AND persist its transcript to disk so it survives a Pit
				// restart (Tier 2). Callers await the disk write so an interrupted run is
				// durably persisted before its result returns; saveResumeState never throws.
				const markResumable = (handle: string, agent: Agent, recordId: string): Promise<void> => {
					rememberResumable(handle, agent, recordId);
					return saveResumeState(cwd, {
						handle,
						messages: agent.state.messages,
						modelId: subModel?.id ?? model.id,
						thinkingLevel: subThinking,
						systemPrompt: effSystemPrompt,
						allowedTools: effAllowedToolsScoped,
						agentScope: hindsightScope,
						cwd: effectiveChildCwd,
						depth: childDepth,
						savedAt: Date.now(),
					});
				};
				const baseChildTools = withAgentScope(
					buildSubagentToolCatalog(options.getAvailableTools(), childDepth, maxDepth, makeCoordinatorTools),
					hindsightScope,
					cwd,
					autoAddMemory,
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
				// parent keep working. Runs on its own controller so it outlives the
				// spawning turn (but Esc / session_shutdown still abort it).
				if (op === "spawn") {
					const handle = name?.trim() ? name.trim() : `task-${++asyncTaskCounter}`;
					// Dedup the handle: a second spawn reusing the SAME `name` while the
					// first is still running would otherwise overwrite the `pending` entry,
					// orphaning the first run's AbortController — session teardown only
					// iterates `pending.values()`, so the first detached run would never be
					// aborted (burning tokens, writing to a now-orphaned worktree) and its
					// result/poll would be unreachable. Reject instead of clobbering the
					// live controller; the caller can pick a distinct name or join/poll the
					// running one first.
					const existing = pending.get(handle);
					if (existing && existing.status === "running") {
						return {
							content: [
								{
									type: "text" as const,
									text: `task: a subagent named "${handle}" is already running. Use a different name, or task({op:"join", handles:["${handle}"]}) it before re-spawning.`,
								},
							],
							isError: true,
							details: { handle, async: true },
						};
					}
					// Mirror prunePending's collectible() predicate: a prior spawn with the
					// SAME `name` that finished (status==="done") but was never joined/polled
					// (delivered===false — the DEFAULT, since async re-injection is off) still
					// holds an unreachable result. Overwriting its `pending` entry would drop
					// that output silently; reject so the caller collects it first.
					if (existing && existing.status === "done" && !existing.delivered) {
						return {
							content: [
								{
									type: "text" as const,
									text: `task: a subagent named "${handle}" already finished but its result hasn't been collected. Read it with task({op:"join", handles:["${handle}"]}) (or op:"poll"), or pick a different name.`,
								},
							],
							isError: true,
							details: { handle, async: true },
						};
					}
					const controller = new AbortController();
					const entry: PendingTask = {
						handle,
						status: "running",
						promise: Promise.resolve(),
						controller,
					};
					// Capture the live Agent and canonical registry identity so a drop/abort
					// leaves a collision-safe resumable transcript.
					let capturedAgent: Agent | undefined;
					let capturedRecordId: string | undefined;
					const messagingOn = options.isMessagingEnabled?.() ?? false;
					let spawnMessagingId: string | undefined;
					let spawnChildTools = baseChildTools;
					let spawnSystemPromptSuffix: string | undefined;
					let spawnMessagingReady: ((agent: Agent) => void) | undefined;
					if (messagingOn) {
						const parentId = options.getParentMessagingId?.();
						const selfId = agentMessageBus.reserve(name ?? handle, { kind: "sub", parentId });
						spawnMessagingId = selfId;
						const timeoutMs = options.getMessagingTimeoutMs?.();
						spawnChildTools = [...baseChildTools, createMessageTool(cwd, { selfId, timeoutMs })];
						spawnSystemPromptSuffix = messagingPreamble(selfId, parentId);
						spawnMessagingReady = (agent) => {
							agentMessageBus.attachResponder(selfId, makeAgentResponder(agent));
							agentMessageBus.attachDelivery(selfId, makeAgentDelivery(agent));
						};
					}
					// The IIFE runs OUTSIDE any enclosing slot-lease context (withoutLease):
					// a detached spawn outlives the spawning turn, so it must never yield or
					// reacquire the spawner's lease from its own promise chain. The slot
					// itself is acquired inside spawnSubagent (single chokepoint); a queue-
					// full / abort rejection is caught below (status="error" +
					// onAsyncComplete) instead of escaping as an unhandledRejection.
					entry.promise = withoutLease(async () => {
						try {
							safeCallback(() => options.onSubagentStart?.(handle), undefined);
							const result = await spawnSubagent(makeSpawnDeps(spawnChildTools, model), {
								prompt,
								model: subModel,
								thinkingLevel: subThinking,
								systemPrompt: effSystemPrompt,
								allowedTools: effAllowedToolsScoped,
								maxTurns: max_turns,
								signal: controller.signal,
								resultSchema,
								worktree: worktree as boolean | { branch?: string; cleanup?: "auto" | "keep" } | undefined,
								timeoutMs: timeout_ms,
								taskName: handle,
								cwd,
								depth: childDepth,
								inheritSkills: inherit_skills,
								systemPromptSuffix: spawnSystemPromptSuffix,
								onWorktreeReady: (path) => {
									effectiveChildCwd = path;
								},
								onSubagentEvent: (info) => options.onSubagentProgress?.(handle, info),
								onAgentReady: (agent, record) => {
									capturedAgent = agent;
									capturedRecordId = record.id;
									spawnMessagingReady?.(agent);
								},
							});
							recordSubagentSpend(result.usage);
							const meta = completeMetaFromUsage(result.record.turnCount, result.usage);
							entry.turns = meta.turns;
							entry.totalTokens = meta.totalTokens;
							// A drop that ended the turn on an error (without throwing) still
							// leaves a resumable transcript — surface it as such, not "done".
							if (capturedAgent && capturedRecordId && agentEndedWithError(capturedAgent) && !usedAutoWorktree) {
								await markResumable(handle, capturedAgent, capturedRecordId);
								entry.status = "error";
								entry.error = "interrupted (resumable)";
								const note = `Subagent '${handle}' was interrupted before finishing — resume with task({op:"resume", name:"${handle}"}).`;
								if (
									safeCallback(() => options.onAsyncComplete?.(handle, note, "error", meta) ?? false, false)
								) {
									entry.delivered = true;
								}
							} else {
								if (capturedAgent && capturedRecordId && !usedAutoWorktree) {
									rememberContinuable(handle, capturedAgent, capturedRecordId);
								}
								// Persist the integral output for op:"read" recovery, then keep only a digest inline.
								outputStore.put(handle, result.output);
								const resultText = formatSpawnResult(result, resultSchema, handle);
								entry.result = resultText;
								entry.status = "done";
								if (
									safeCallback(
										() => options.onAsyncComplete?.(handle, resultText, "done", meta) ?? false,
										false,
									)
								) {
									entry.delivered = true;
								}
							}
						} catch (err) {
							const failedUsage = getSubagentErrorUsage(err);
							recordSubagentSpend(failedUsage);
							entry.totalTokens = failedUsage?.totalTokens ?? entry.totalTokens;
							entry.error = err instanceof Error ? err.message : String(err);
							entry.status = "error";
							if (capturedAgent && capturedRecordId && !usedAutoWorktree) {
								await markResumable(handle, capturedAgent, capturedRecordId);
							}
							const suffix =
								capturedAgent && !usedAutoWorktree ? ` Resume with task({op:"resume", name:"${handle}"}).` : "";
							if (
								safeCallback(
									() =>
										options.onAsyncComplete?.(handle, `${entry.error}${suffix}`, "error", {
											turns: entry.turns,
											totalTokens: entry.totalTokens,
										}) ?? false,
									false,
								)
							) {
								entry.delivered = true;
							}
						} finally {
							if (spawnMessagingId) agentMessageBus.unregister(spawnMessagingId);
						}
					});
					pending.set(handle, entry);
					prunePending();
					const worktreeNote = usedAutoWorktree
						? " Note: worktree cleanup:auto — this spawn is not resumable/continuable after settle."
						: "";
					return {
						content: [
							{
								type: "text" as const,
								text: `Spawned subagent '${handle}' (non-blocking). Keep working, then collect its result with task({op:"join", handles:["${handle}"]}) — results are NOT auto-delivered, so you must join (or poll) to read them. Check status anytime with task({op:"poll", handles:["${handle}"]}).${worktreeNote}`,
							},
						],
						isError: false,
						details: { handle, async: true, depth: childDepth, usedAutoWorktree },
					};
				}

				// Inter-agent messaging wiring. Reserve a bus id up front so the
				// `message` tool can be bound to it, and attach the live responder
				// once the Agent exists. The id is unregistered in the `finally`
				// below — guaranteed even if spawnSubagent throws before its own
				// teardown runs (e.g. a worktree-setup failure).
				const messagingOn = options.isMessagingEnabled?.() ?? false;
				const runHandle = name?.trim() ? name.trim() : `run-${++runTaskCounter}`;
				// Capture the live Agent and canonical registry identity so interrupted
				// runs remain collision-safe when resumed by their public handle.
				let capturedAgent: Agent | undefined;
				let capturedRecordId: string | undefined;
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

				// The run slot is acquired inside spawnSubagent (single chokepoint);
				// queue time is not counted against the task timeout. A queue-full /
				// ESC rejection falls into the catch below (returns isError) instead
				// of escaping execute() and crashing the batch.
				try {
					safeCallback(() => options.onSubagentStart?.(runHandle), undefined);
					const spawnOpts = {
						prompt,
						model: subModel,
						thinkingLevel: subThinking,
						systemPrompt: effSystemPrompt,
						allowedTools: effAllowedToolsScoped,
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
						onWorktreeReady: (path: string) => {
							effectiveChildCwd = path;
						},
						onSubagentEvent: (info: { turn: number; lastTool?: string }) =>
							options.onSubagentProgress?.(runHandle, info),
						onAgentReady: (agent: Agent, record: { id: string }) => {
							capturedAgent = agent;
							capturedRecordId = record.id;
							messagingReady?.(agent);
						},
					};
					const hasGate = !!(acceptance?.criteria || acceptance?.check);
					const gated = hasGate
						? await runWithAcceptance(makeSpawnDeps(childTools, model), spawnOpts, acceptance)
						: undefined;
					const result = gated?.result ?? (await spawnSubagent(makeSpawnDeps(childTools, model), spawnOpts));
					const effectiveUsage = gated?.usage ?? result.usage;
					recordSubagentSpend(effectiveUsage);
					const interrupted = !!capturedAgent && agentEndedWithError(capturedAgent);
					if (interrupted && capturedAgent && capturedRecordId && !usedAutoWorktree) {
						await markResumable(runHandle, capturedAgent, capturedRecordId);
					} else {
						resumable.delete(runHandle);
						if (!interrupted && capturedAgent && capturedRecordId && !usedAutoWorktree) {
							rememberContinuable(runHandle, capturedAgent, capturedRecordId);
						}
					}
					// op:"read" recovers by the canonical (collision-resolved) taskName the
					// result details surface, so persist and cite that same key.
					const readHandle = result.record.taskName;
					outputStore.put(readHandle, result.output);
					let text = gated ? gated.text : formatSpawnResult(result, resultSchema, readHandle);
					const gateDetails: GateDetails | undefined = gated?.gate;
					if (interrupted) {
						text = `${text}\n\n[subagent ended on an error turn — resume with task({op:"resume", name:"${runHandle}"})]`;
					}
					if (usedAutoWorktree) {
						text = `${text}\n\n[not resumable/continuable — worktree cleanup:auto]`;
					}
					emitBlockingComplete(runHandle, interrupted ? "error" : "done", result.record.turnCount, effectiveUsage);
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
							usedAutoWorktree,
							...(gateDetails ? { gate: gateDetails } : {}),
						},
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const failedUsage = getSubagentErrorUsage(err);
					recordSubagentSpend(failedUsage);
					if (capturedAgent && capturedRecordId && !usedAutoWorktree) {
						await markResumable(runHandle, capturedAgent, capturedRecordId);
					}
					const hint =
						capturedAgent && !usedAutoWorktree ? ` Resume with task({op:"resume", name:"${runHandle}"}).` : "";
					emitBlockingComplete(runHandle, "error", undefined, failedUsage);
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
				}
			},
		});
	}

	const acceptanceFieldSchema = Type.Object({
		criteria: Type.Optional(Type.String()),
		check: Type.Optional(Type.String()),
		max_attempts: Type.Optional(Type.Number()),
	});

	// Shared per-task/stage model guidance — same cost heuristic as `task`'s
	// `model` field, so heterogeneous fan-out (cheap models for mechanical
	// probes) works through the structured tools too, not only via manual spawns.
	const subModelFieldSchema = Type.Optional(
		Type.String({
			description:
				"Model for this task — pick the smallest model that can do it well: 'haiku' for trivial/mechanical work, " +
				"'sonnet' for focused analysis or simple code, OMIT to inherit the parent's model for hard reasoning. " +
				"Pattern: 'haiku' | 'sonnet' | 'opus' | 'provider/id' (optionally ':level').",
		}),
	);
	const subThinkingFieldSchema = Type.Optional(
		Type.String({ description: "Reasoning level for this task: minimal|low|medium|high|xhigh." }),
	);

	const parallelTaskSchema = Type.Object({
		name: Type.Optional(Type.String()),
		prompt: Type.String(),
		allowed_tools: Type.Optional(Type.Array(Type.String())),
		result_schema: Type.Optional(Type.Unknown()),
		acceptance: Type.Optional(acceptanceFieldSchema),
		type: Type.Optional(
			Type.String({
				description:
					"Reusable agent type from .pit/agents — applies its system prompt, tools, model, and thinking level as defaults for this task (same as `task`'s type field).",
			}),
		),
		model: subModelFieldSchema,
		thinking_level: subThinkingFieldSchema,
	});

	const parallelSchema = Type.Object({
		tasks: Type.Array(parallelTaskSchema),
		concurrency: Type.Optional(Type.Number()),
	});

	const fanoutStageSchema = Type.Object({
		prompt: Type.String(),
		allowed_tools: Type.Optional(Type.Array(Type.String())),
		result_schema: Type.Optional(Type.Unknown()),
		acceptance: Type.Optional(acceptanceFieldSchema),
		type: Type.Optional(Type.String({ description: "Reusable agent type applied to this stage." })),
		model: subModelFieldSchema,
		thinking_level: subThinkingFieldSchema,
	});

	const fanoutReviewerSchema = Type.Object({
		prompt_template: Type.String({ description: "Prompt template with {{target}} placeholder." }),
		allowed_tools: Type.Optional(Type.Array(Type.String())),
		type: Type.Optional(Type.String({ description: "Reusable agent type applied to every reviewer." })),
		model: subModelFieldSchema,
		thinking_level: subThinkingFieldSchema,
	});

	const fanoutSchema = Type.Object({
		scout: fanoutStageSchema,
		reviewer: fanoutReviewerSchema,
		worker: fanoutStageSchema,
		concurrency: Type.Optional(Type.Number()),
	});

	/**
	 * Formats one settled parallel/fanout child for the parent's context: the
	 * integral output is persisted for op:"read" recovery and only a head+tail
	 * digest (plus the recovery pointer) is inlined — the same context economy
	 * the single `task` op applies (N7). Also records the child's spend.
	 */
	function formatChildResult(r: ParallelTaskResult): string {
		recordSubagentSpend(r.usage);
		const status = r.ok ? "ok" : "FAILED";
		const gateNote = r.gate ? ` (gate ${r.gate.passed ? "passed" : "failed"}, attempts=${r.gate.attempts})` : "";
		let body: string;
		if (r.ok) {
			const raw = r.value !== undefined ? JSON.stringify(r.value, null, 2) : (r.output ?? "");
			outputStore.put(r.taskName, raw);
			body = digestWithPointer(raw, r.taskName);
		} else {
			body = `[failed: ${r.error ?? "error"}]`;
		}
		return `### ${r.taskName} [${status}]${gateNote}\n${body}`;
	}

	/** Compact per-child summary for tool details (no full outputs — those live in the store). */
	function summarizeChildResults(results: ParallelTaskResult[]): Array<Record<string, unknown>> {
		return results.map((r) => ({
			taskName: r.taskName,
			ok: r.ok,
			...(r.turns !== undefined ? { turns: r.turns } : {}),
			...(r.usage ? { totalTokens: r.usage.totalTokens } : {}),
			...(r.error ? { error: r.error } : {}),
			...(r.gate ? { gate: r.gate } : {}),
		}));
	}

	function makeParallelTool(depth: number) {
		return brandCoordinatorTool({
			name: PARALLEL_TOOL_NAME,
			label: PARALLEL_TOOL_NAME,
			description:
				"Run multiple subagent tasks concurrently and collect all results. " +
				"Each task may carry its own acceptance gate, agent `type`, and `model` — " +
				"scale each task's model to its complexity (cheap models for mechanical probes). " +
				"Partial failures are isolated — one task's error does not abort the others. " +
				`Each result is a compact digest; recover a task's integral output with task({op:"${SUBAGENT_READ_OP}", name:"<taskName>"}).`,
			parameters: parallelSchema,
			sideEffect: "agent",
			async execute(_id: string, params: unknown, signal?: AbortSignal): Promise<TaskOpResult> {
				const p = params as Static<typeof parallelSchema>;
				if (!p.tasks?.length) {
					return {
						content: [{ type: "text" as const, text: "parallel: `tasks` array is required." }],
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
				const budgetBlocked = spawnBudgetBlock();
				if (budgetBlocked) return budgetBlocked;
				const childDepth = depth + 1;
				const cwd = options.getCwd ? options.getCwd() : process.cwd();
				const childTools = buildSubagentToolCatalog(
					options.getAvailableTools(),
					childDepth,
					maxDepth,
					makeCoordinatorTools,
				);
				const { model: subModel, thinkingLevel: subThinking } = await resolveSubModel(undefined, undefined);
				// Per-task overrides: agent type (system prompt/tools/model/thinking
				// defaults) and model pattern, mirroring the single `task` op. Resolved
				// up front so an unknown type fails the whole call loudly instead of
				// one child failing quietly mid-batch.
				const tasks = [];
				for (const t of p.tasks) {
					const preset = await resolveChildPreset(t, childTools, cwd);
					if ("error" in preset) {
						return {
							content: [{ type: "text" as const, text: `parallel: ${preset.error}` }],
							isError: true,
							details: undefined,
						};
					}
					tasks.push({
						name: t.name,
						prompt: t.prompt,
						allowed_tools: preset.allowedTools,
						result_schema: coerceResultSchema(t.result_schema),
						acceptance: t.acceptance,
						model: preset.model,
						thinkingLevel: preset.thinkingLevel,
						systemPrompt: preset.systemPrompt,
						tools: preset.tools,
					});
				}
				try {
					// Concurrency is enforced per child inside spawnSubagent (one slot per
					// live Agent) — a parallel batch can no longer bypass the budget.
					const results = await spawnAll(makeSpawnDeps(childTools, model), tasks, {
						concurrency: p.concurrency,
						base: {
							model: subModel,
							thinkingLevel: subThinking,
							cwd,
							depth: childDepth,
							signal,
						},
						// Children surface in the TUI like any other subagent run.
						onTaskStart: (h) => options.onSubagentStart?.(h),
						onTaskEvent: (h, info) => options.onSubagentProgress?.(h, info),
						onTaskComplete: (h, status, meta) => options.onSubagentComplete?.(h, status, meta),
					});
					const sections = results.map((r) => formatChildResult(r));
					const totalTokens = results.reduce((sum, r) => sum + (r.usage?.totalTokens ?? 0), 0);
					return {
						content: [{ type: "text" as const, text: sections.join("\n\n") }],
						isError: false,
						details: { results: summarizeChildResults(results), depth: childDepth, totalTokens },
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `parallel failed: ${message}` }],
						isError: true,
						details: undefined,
					};
				}
			},
		});
	}

	function makeFanoutTool(depth: number) {
		return brandCoordinatorTool({
			name: FANOUT_TOOL_NAME,
			label: FANOUT_TOOL_NAME,
			description:
				"Orchestrate scout → N reviewers → worker in one call. " +
				"The scout determines how many reviewers run; each reviewer prompt uses {{target}} substitution. " +
				"The worker receives collected reviews and may carry an acceptance gate. " +
				"Each stage accepts its own agent `type` and `model` — run reviewers on a cheap tier ('haiku') and keep the worker strong. " +
				`Outputs are compact digests; recover an integral output with task({op:"${SUBAGENT_READ_OP}", name:"<taskName>"}).`,
			parameters: fanoutSchema,
			sideEffect: "agent",
			async execute(_id: string, params: unknown, signal?: AbortSignal): Promise<TaskOpResult> {
				const p = params as Static<typeof fanoutSchema>;
				const model = options.getParentModel();
				if (!model) {
					return {
						content: [{ type: "text" as const, text: "No model available for subagent." }],
						isError: true,
						details: undefined,
					};
				}
				const budgetBlocked = spawnBudgetBlock();
				if (budgetBlocked) return budgetBlocked;
				const childDepth = depth + 1;
				const cwd = options.getCwd ? options.getCwd() : process.cwd();
				const childTools = buildSubagentToolCatalog(
					options.getAvailableTools(),
					childDepth,
					maxDepth,
					makeCoordinatorTools,
				);
				const { model: subModel, thinkingLevel: subThinking } = await resolveSubModel(undefined, undefined);
				// Full per-stage presets (agent type + scoped memory/tools + model +
				// thinking), so fanout has the same heterogeneous configuration surface
				// as `task` and `parallel`.
				const scoutPreset = await resolveChildPreset(p.scout, childTools, cwd);
				const reviewerPreset = await resolveChildPreset(p.reviewer, childTools, cwd);
				const workerPreset = await resolveChildPreset(p.worker, childTools, cwd);
				for (const [stage, preset] of [
					["scout", scoutPreset],
					["reviewer", reviewerPreset],
					["worker", workerPreset],
				] as const) {
					if ("error" in preset) {
						return {
							content: [{ type: "text" as const, text: `fanout ${stage}: ${preset.error}` }],
							isError: true,
							details: undefined,
						};
					}
				}
				if ("error" in scoutPreset || "error" in reviewerPreset || "error" in workerPreset) {
					throw new Error("unreachable preset resolution state");
				}
				try {
					// Concurrency is enforced per stage/reviewer inside spawnSubagent (one
					// slot per live Agent) — the pipeline can no longer bypass the budget.
					const fanoutResult = await runFanout(
						makeSpawnDeps(childTools, model),
						{
							scout: {
								prompt: p.scout.prompt,
								allowed_tools: scoutPreset.allowedTools,
								result_schema: coerceResultSchema(p.scout.result_schema),
								model: scoutPreset.model,
								thinkingLevel: scoutPreset.thinkingLevel,
								systemPrompt: scoutPreset.systemPrompt,
								tools: scoutPreset.tools,
							},
							reviewer: {
								prompt_template: p.reviewer.prompt_template,
								allowed_tools: reviewerPreset.allowedTools,
								model: reviewerPreset.model,
								thinkingLevel: reviewerPreset.thinkingLevel,
								systemPrompt: reviewerPreset.systemPrompt,
								tools: reviewerPreset.tools,
							},
							worker: {
								prompt: p.worker.prompt,
								allowed_tools: workerPreset.allowedTools,
								result_schema: coerceResultSchema(p.worker.result_schema),
								acceptance: p.worker.acceptance,
								model: workerPreset.model,
								thinkingLevel: workerPreset.thinkingLevel,
								systemPrompt: workerPreset.systemPrompt,
								tools: workerPreset.tools,
							},
							concurrency: p.concurrency,
						},
						{
							depth,
							cwd,
							model: subModel,
							thinkingLevel: subThinking,
							signal,
							// Stages surface in the TUI like any other subagent run.
							onStageStart: (h) => options.onSubagentStart?.(h),
							onStageEvent: (h, info) => options.onSubagentProgress?.(h, info),
							onStageComplete: (h, status, meta) => options.onSubagentComplete?.(h, status, meta),
						},
					);
					// Record the WHOLE pipeline's spend: scout + every reviewer + worker
					// (reviewers are recorded inside formatChildResult below).
					recordSubagentSpend(fanoutResult.scout_usage);
					recordSubagentSpend(fanoutResult.worker_output.usage);
					// Same context economy as `task` (N7): persist integral scout,
					// reviewer, and worker outputs for op:"read"; inline only digests +
					// recovery pointers. Even a huge scout target list cannot flood the
					// parent context now.
					const scoutHandle = fanoutResult.scout_task_name ?? "fanout-scout";
					const scoutOutput = fanoutResult.scout_output ?? JSON.stringify(fanoutResult.targets);
					outputStore.put(scoutHandle, scoutOutput);
					const workerHandle = fanoutResult.worker_task_name ?? "fanout-worker";
					outputStore.put(workerHandle, fanoutResult.worker_output.text);
					const reviewSections = fanoutResult.reviews.map((r) => formatChildResult(r));
					const text = [
						`## Scout targets (${fanoutResult.targets.length}) [${scoutHandle}]\n${digestWithPointer(scoutOutput, scoutHandle)}`,
						`## Reviews\n${reviewSections.join("\n\n") || "(no reviewers ran)"}`,
						`## Worker output [${workerHandle}]${fanoutResult.gate ? ` (gate ${fanoutResult.gate.passed ? "passed" : "failed"}, attempts=${fanoutResult.gate.attempts})` : ""}\n${digestWithPointer(fanoutResult.worker_output.text, workerHandle)}`,
					].join("\n\n");
					return {
						content: [{ type: "text" as const, text }],
						isError: fanoutResult.worker_output.isError,
						details: {
							targetCount: fanoutResult.targets.length,
							scoutTaskName: scoutHandle,
							reviews: summarizeChildResults(fanoutResult.reviews),
							workerTaskName: workerHandle,
							gate: fanoutResult.gate,
							depth: childDepth,
						},
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					recordSubagentSpend(getSubagentErrorUsage(err));
					return {
						content: [{ type: "text" as const, text: `fanout failed: ${message}` }],
						isError: true,
						details: undefined,
					};
				}
			},
		});
	}

	function makeCoordinatorTools(childDepth: number): AgentTool[] {
		return [makeTaskTool(childDepth), makeParallelTool(childDepth), makeFanoutTool(childDepth)];
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
		const childTools = buildSubagentToolCatalog(
			options.getAvailableTools(),
			state.depth,
			maxDepth,
			makeCoordinatorTools,
		);
		// A kept-worktree resume state stores that checkout as state.cwd. Rebind
		// native tools there before seeding the resumed Agent; otherwise Tier-2
		// resume would silently mutate the parent checkout after a restart.
		const cwdBoundChildTools =
			state.cwd !== cwd
				? (options.retargetToolsForCwd ?? retargetToolsForWorktree)(childTools, state.cwd)
				: childTools;
		const scopedChildTools =
			process.env.PIT_NO_SCOPED_HINDSIGHT === "1"
				? cwdBoundChildTools
				: withAgentScope(cwdBoundChildTools, state.agentScope, state.cwd, false);
		const text =
			continuation?.trim() ||
			"You were interrupted before finishing. Continue from where you left off using the conversation above, then give your final answer.";
		// The run slot is acquired inside spawnSubagent (single chokepoint).
		// Capture the live Agent so a resume that resolves but ends on an error turn
		// (a fresh network drop ending the turn with stopReason "error" WITHOUT
		// throwing — exactly what resume exists to recover from) is detected before
		// we delete the only persisted transcript. Mirrors the agentEndedWithError
		// guard the in-memory (resumeHandle) and synchronous spawn paths already have.
		let capturedAgent: Agent | undefined;
		try {
			const budgetBlocked = spawnBudgetBlock();
			if (budgetBlocked) return budgetBlocked;
			const result = await spawnSubagent(makeSpawnDeps(scopedChildTools, model), {
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
				onAgentReady: (agent) => {
					capturedAgent = agent;
				},
			});
			recordSubagentSpend(result.usage);
			if (capturedAgent && agentEndedWithError(capturedAgent)) {
				// Still unfinished — keep the on-disk transcript (do NOT delete) so a
				// later attempt can resume again, and persist the latest progress so the
				// next resume continues from here instead of replaying the old seed. Save
				// to the same `cwd` load/delete use so the next op:"resume" finds it.
				await saveResumeState(cwd, {
					handle: key,
					messages: capturedAgent.state.messages,
					modelId: state.modelId,
					thinkingLevel: state.thinkingLevel,
					systemPrompt: state.systemPrompt,
					allowedTools: state.allowedTools,
					agentScope: state.agentScope,
					cwd: state.cwd,
					depth: state.depth,
					savedAt: Date.now(),
				});
				return {
					content: [
						{
							type: "text" as const,
							text: `Resume of "${key}" did not complete (it erred again). It remains resumable.`,
						},
					],
					isError: true,
					details: { handle: key, resumed: true, fromDisk: true, stillResumable: true },
				};
			}
			await deleteResumeState(cwd, key);
			outputStore.put(key, result.output);
			const out = formatSpawnResult(result, undefined, key);
			return {
				content: [{ type: "text" as const, text: out }],
				isError: false,
				details: { handle: key, resumed: true, fromDisk: true },
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			recordSubagentSpend(getSubagentErrorUsage(err));
			return {
				content: [{ type: "text" as const, text: `Subagent resume failed: ${message}` }],
				isError: true,
				details: { handle: key, resumed: true },
			};
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
		for (const tool of makeCoordinatorTools(0)) {
			// Definitions are built for registerTool; brandCoordinatorTool keeps the
			// same shape while the subagent catalog treats them as AgentTools.
			pi.registerTool(tool as unknown as ToolDefinition);
		}
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
			if (inflight.length > 0) {
				let graceTimer: ReturnType<typeof setTimeout> | undefined;
				const grace = new Promise<void>((r) => {
					graceTimer = setTimeout(r, 1500);
				});
				try {
					await Promise.race([Promise.all(inflight), grace]);
				} finally {
					if (graceTimer !== undefined) clearTimeout(graceTimer);
				}
			}
			// N7: remove the on-disk integral-output store (session temp dir). Best-effort;
			// once the parent session is gone, op:"read" recovery is moot.
			outputStore.dispose();
		});
	};
}
