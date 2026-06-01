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

import type { TSchema } from "typebox";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

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
}

export interface SpawnSubagentOptions {
	prompt: string;
	/** Override system prompt. Defaults to a generic task-completion prompt. */
	systemPrompt?: string;
	/** Subset of parent's tool names available to the subagent. */
	allowedTools?: string[];
	/** Maximum turns. Default: 25. */
	maxTurns?: number;
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
	/** Nesting depth of the subagent being spawned (0 = top-level). Recorded for `/tasks` visibility. */
	depth?: number;
	/**
	 * When true, the parent's model-invocable skills are appended to the
	 * subagent's system prompt (via formatSkillsForPrompt). Without this the
	 * subagent runs skill-blind: skills are prompt-injected, not tools, and the
	 * subagent uses its own minimal system prompt.
	 */
	inheritSkills?: boolean;
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
}
