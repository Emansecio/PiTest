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

import type { Static, TSchema } from "typebox";

export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SubagentRecord {
	id: string;
	prompt: string;
	systemPrompt?: string;
	allowedTools?: string[];
	status: SubagentStatus;
	startedAt?: number;
	endedAt?: number;
	output?: string;
	error?: string;
	turnCount: number;
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
	 * `<cwd>/.pi/worktrees/<taskName>-<uuid>` checked out at the parent's HEAD.
	 *
	 * - `true` or `{ cleanup: "auto" }` — worktree is removed when the task
	 *   settles (success, failure, or cancellation).
	 * - `{ cleanup: "keep" }` — worktree is left in place; the path is returned
	 *   in the result so the parent can inspect it.
	 */
	worktree?: boolean | WorktreeSpec;
	/** Hard wall-clock timeout for the subagent. */
	timeoutMs?: number;
	/** Optional task name used for the worktree path + agent:// scheme lookup. */
	taskName?: string;
	/** Working directory used as the parent for `.pi/worktrees` and the default cwd. */
	cwd?: string;
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

/**
 * Higher-level task spec used by the `task` tool surface. Mirrors
 * `SpawnSubagentOptions` but with the user-facing field names from the API.
 */
export interface SubagentTaskSpec<Schema extends TSchema = TSchema> {
	name: string;
	prompt: string;
	resultSchema?: Schema;
	worktree?: boolean | WorktreeSpec;
	timeoutMs?: number;
	model?: string;
}

/**
 * Final result of a `SubagentTaskSpec`. When `ok` and `resultSchema` was
 * provided, `value` is the parsed-and-validated `Static<Schema>`. The raw
 * assistant text is always in `output` (when produced).
 */
export interface SubagentTaskResult<T = unknown> {
	taskName: string;
	ok: boolean;
	value?: T;
	output?: string;
	error?: string;
	cost?: { tokens?: number; durationMs?: number };
	worktreePath?: string;
}

export type StaticOf<S extends TSchema> = Static<S>;
