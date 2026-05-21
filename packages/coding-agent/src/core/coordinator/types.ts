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
}

export interface SpawnSubagentResult {
	record: SubagentRecord;
	output: string;
}
