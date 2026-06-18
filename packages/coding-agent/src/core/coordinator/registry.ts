/**
 * Registry of currently active subagents. The registry is in-memory only and
 * lives for the life of the parent AgentSession.
 */

import { randomBytes } from "node:crypto";
import type { SubagentRecord, SubagentStatus } from "./types.ts";

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set(["completed", "failed", "cancelled"]);

export class SubagentRegistry {
	private records = new Map<string, SubagentRecord>();
	/** Live mirror of every record's taskName for O(1) collision checks in create(). */
	private takenNames = new Set<string>();
	/**
	 * Cap on retained TERMINAL records (running/pending are never evicted). Without
	 * this the map grew once per subagent for the whole session — each record pins
	 * the full prompt + output. Evicted on every create(), oldest terminal first.
	 */
	private static readonly MAX_TERMINAL_RECORDS = 64;

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
		this.takenNames.add(record.taskName);
		this.evictTerminal();
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
		if (!this.takenNames.has(desired)) return desired;
		return `${desired}-${id.slice(4)}`;
	}

	/** Drop the oldest terminal records once their count exceeds the cap. */
	private evictTerminal(): void {
		let terminal = 0;
		for (const r of this.records.values()) {
			if (TERMINAL_STATUSES.has(r.status)) terminal++;
		}
		if (terminal <= SubagentRegistry.MAX_TERMINAL_RECORDS) return;
		for (const [id, r] of this.records) {
			if (terminal <= SubagentRegistry.MAX_TERMINAL_RECORDS) break;
			if (TERMINAL_STATUSES.has(r.status)) {
				this.records.delete(id);
				this.takenNames.delete(r.taskName);
				terminal--;
			}
		}
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
		const record = this.records.get(id);
		if (record) this.takenNames.delete(record.taskName);
		this.records.delete(id);
	}

	clear(): void {
		this.records.clear();
		this.takenNames.clear();
	}
}
