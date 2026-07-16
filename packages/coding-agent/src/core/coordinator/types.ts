/**
 * Subagent coordinator types.
 *
 * A "subagent" is a lightweight Agent spawned from the parent session. It
 * shares the parent's model, auth, and tool catalog (filtered) but runs in
 * an in-memory session, so its turns never persist to the parent's session
 * file.
 *
 * Use cases:
 *   - Decomposing a large task into parallel research probes
 *   - Sandboxing one-shot LLM queries with restricted tool access
 *   - Running the same prompt against multiple personas
 */

import type { AgentMessage, ThinkingLevel } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import type { TSchema } from "typebox";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** Aggregate token/cost usage for a subagent run, summed across its turns. */
export interface SubagentUsage {
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	costUsd: number;
}

/**
 * Lightweight progress signal emitted while a subagent runs, so the parent can
 * surface live status (turn N, last tool) instead of a black box until settle.
 * Deliberately coarse — one event per turn, not per streamed token.
 */
export interface SubagentProgressInfo {
	/** 1-based turn the subagent just finished. */
	turn: number;
	/** Name of the last tool the subagent called this turn, if any. */
	lastTool?: string;
}

export interface SubagentRecord {
	id: string;
	/** Unique, collision-resolved task name (see SubagentRegistry.create). */
	taskName: string;
	/** Nesting depth: 0 for a top-level spawn, incremented for each nested subagent. */
	depth: number;
	prompt: string;
	systemPrompt?: string;
	allowedTools?: string[];
	status: SubagentStatus;
	startedAt?: number;
	endedAt?: number;
	output?: string;
	error?: string;
	turnCount: number;
	/** Tool calls the subagent attempted that the parent's policy denied (headless ask→deny included). */
	deniedToolCalls?: string[];
	/** Aggregate token/cost usage, accumulated across the subagent's turns. */
	usage?: SubagentUsage;
}

export interface SpawnSubagentOptions {
	prompt: string;
	/**
	 * Seed transcript when resuming an interrupted subagent from disk (Tier 2).
	 * The continuation `prompt` runs on top of these prior messages so the model
	 * continues with full context instead of starting fresh.
	 */
	initialMessages?: AgentMessage[];
	/**
	 * Model for the subagent. Defaults to the parent's model (`deps.model`).
	 * Lets a heterogeneous fan-out run trivial probes on a cheaper model while
	 * the parent stays on its own tier.
	 */
	model?: Model<any>;
	/**
	 * Reasoning level for the subagent. Defaults to "medium" — subagents always
	 * think (never "off"). Pass an explicit level to override per task.
	 */
	thinkingLevel?: ThinkingLevel;
	/** Override system prompt. Defaults to a generic task-completion prompt. */
	systemPrompt?: string;
	/** Subset of parent's tool names available to the subagent. */
	allowedTools?: string[];
	/** Maximum turns. Default: DEFAULT_MAX_TURNS (50). */
	maxTurns?: number;
	/**
	 * Optional progress callback, invoked once per finished turn while the subagent
	 * runs. Lets the coordinator surface live status (turn N, last tool) to the
	 * parent/TUI instead of the subagent being a black box until it settles.
	 */
	onSubagentEvent?: (info: SubagentProgressInfo) => void;
	/** Cancellation signal. */
	signal?: AbortSignal;
	/**
	 * If set, the subagent's final assistant message is parsed and validated
	 * against this typebox schema. The parsed value is returned on `value`.
	 */
	resultSchema?: TSchema;
	/**
	 * If truthy, the subagent runs inside an isolated git worktree rooted at
	 * `<cwd>/.pit/worktrees/<taskName>-<uuid>` checked out at the parent's HEAD.
	 *
	 * - `true` or `{ cleanup: "auto" }` — worktree is removed when the task
	 *   settles (success, failure, or cancellation).
	 * - `{ cleanup: "keep" }` — worktree is left in place; the path is returned
	 *   in the result so the parent can inspect it.
	 */
	worktree?: boolean | WorktreeSpec;
	/** Hard wall-clock timeout for the subagent. */
	timeoutMs?: number;
	/** Optional task name used for the worktree path. Collisions are auto-resolved to stay unique. */
	taskName?: string;
	/** Working directory used as the parent for `.pit/worktrees` and the default cwd. */
	cwd?: string;
	/** Nesting depth of the subagent being spawned (0 = top-level). Recorded on the registry. */
	depth?: number;
	/**
	 * When true, the parent's model-invocable skills are appended to the
	 * subagent's system prompt (via formatSkillsForPrompt). Without this the
	 * subagent runs skill-blind: skills are prompt-injected, not tools, and the
	 * subagent uses its own minimal system prompt.
	 */
	inheritSkills?: boolean;
	/**
	 * Appended to the subagent's system prompt (after skills, before the
	 * result-schema suffix). Used to inject coordination instructions without
	 * the coordinator needing to know the default system prompt.
	 */
	systemPromptSuffix?: string;
	/**
	 * Called after an isolated worktree is created, before tools/the Agent are
	 * built. Used by acceptance cleanup and persisted-resume cwd tracking.
	 */
	onWorktreeReady?: (path: string) => void;
	/**
	 * Called once with the live `Agent` and its canonical registry record
	 * immediately after construction and before its first turn. Existing one-arg
	 * callbacks remain compatible. Used to attach the agent to the message bus and
	 * retain collision-safe record identity for in-memory resume/continue.
	 */
	onAgentReady?: (agent: import("@pit/agent-core").Agent, record: SubagentRecord) => void;
	/**
	 * Called exactly once when the subagent settles (success, failure, or
	 * cancellation) — `spawnSubagent` guards it with a once-flag. General-purpose
	 * teardown hook for external callers. Note: it does NOT fire when worktree
	 * setup throws before the agent is built, so the built-in coordinator unregisters
	 * its bus id with its own `finally` rather than relying on this hook.
	 */
	onSettle?: () => void;
}

export interface WorktreeSpec {
	branch?: string;
	cleanup?: "auto" | "keep";
}

export interface SpawnSubagentResult {
	record: SubagentRecord;
	output: string;
	/** Present when `resultSchema` was set and parsing succeeded. */
	value?: unknown;
	/** Absolute path of the git worktree, if one was created. */
	worktreePath?: string;
	/** Aggregate token/cost usage for the run, when the provider reported it. */
	usage?: SubagentUsage;
}
