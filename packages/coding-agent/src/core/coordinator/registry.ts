/**
 * Registry of currently active subagents. The registry is in-memory only and
 * lives for the life of the parent AgentSession.
 */

import { randomBytes } from "node:crypto";
import type { SubagentRecord, SubagentStatus } from "./types.ts";

export class SubagentRegistry {
	private records = new Map<string, SubagentRecord>();

	create(input: {
		prompt: string;
		systemPrompt?: string;
		allowedTools?: string[];
		taskName?: string;
		depth?: number;
	}): SubagentRecord {
		const id = `sub_${randomBytes(8).toString("hex")}`;
		const record: SubagentRecord = {
			id,
			taskName: this.uniqueTaskName(input.taskName, id),
			depth: input.depth ?? 0,
			prompt: input.prompt,
			systemPrompt: input.systemPrompt,
			allowedTools: input.allowedTools,
			status: "pending",
			turnCount: 0,
		};
		this.records.set(id, record);
		return record;
	}

	/**
	 * Resolves a unique task name. With no name supplied, the subagent id is used
	 * (already unique). When a supplied name collides with another tracked
	 * subagent, the unique id suffix is appended — so parallel spawns that reuse
	 * the same `name` never clash on worktree paths or result identity.
	 */
	private uniqueTaskName(desired: string | undefined, id: string): string {
		if (!desired) return id;
		const taken = new Set([...this.records.values()].map((r) => r.taskName));
		if (!taken.has(desired)) return desired;
		return `${desired}-${id.slice(4)}`;
	}

	update(id: string, patch: Partial<SubagentRecord>): SubagentRecord | undefined {
		const record = this.records.get(id);
		if (!record) return undefined;
		Object.assign(record, patch);
		return record;
	}

	setStatus(id: string, status: SubagentStatus): void {
		const record = this.records.get(id);
		if (record) record.status = status;
	}

	get(id: string): SubagentRecord | undefined {
		return this.records.get(id);
	}

	list(): SubagentRecord[] {
		return [...this.records.values()];
	}

	remove(id: string): void {
		this.records.delete(id);
	}

	clear(): void {
		this.records.clear();
	}
}
