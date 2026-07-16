/**
 * On-disk persistence for interrupted subagents (resume Tier 2).
 *
 * The in-memory `resumable` map (Tier 1) only survives within a session. To
 * resume after the Pit process is closed or crashes, the partial transcript +
 * spawn context are also written to `<cwd>/.pit/subagents/<handle>.json` when a
 * subagent is interrupted, and read back when `op:"resume"` finds no live Agent
 * for the handle. The file is removed once the resume completes.
 *
 * All operations are best-effort: a write/read/delete failure never throws into
 * the agent loop — persistence is an enhancement, not a correctness dependency.
 */

import { readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import { writeFileAtomic } from "../../utils/atomic-write.ts";
import { redactForDisk } from "../secret-redactor.ts";

/**
 * Max age of a persisted resume state. Resume files are only deleted on a
 * SUCCESSFUL resume, so an interrupted subagent that is never resumed would
 * otherwise pin its transcript in `.pit/subagents/` forever — and keep
 * resurfacing as a stale "(persisted)" handle in `op:"list"` across sessions.
 * Expired states are garbage-collected lazily on list/load (best-effort).
 */
export const RESUME_STATE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface ResumeState {
	/** Handle the subagent was tracked under (already filesystem-safe). */
	handle: string;
	/** Partial transcript captured at interruption (trailing failure turn dropped on resume). */
	messages: AgentMessage[];
	/** Model id, re-resolved against the registry on resume (falls back to parent). */
	modelId?: string;
	thinkingLevel?: string;
	systemPrompt?: string;
	allowedTools?: string[];
	/** Agent scope to rebind hindsight tools to on disk-resume (undefined = global). */
	agentScope?: string;
	cwd: string;
	depth: number;
	savedAt: number;
}

function storeDir(cwd: string): string {
	return join(cwd, ".pit", "subagents");
}

/** Filesystem-safe filename stem for a handle (handles are usually already safe). */
function sanitize(handle: string): string {
	return handle.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "task";
}

function stateFile(cwd: string, handle: string): string {
	return join(storeDir(cwd), `${sanitize(handle)}.json`);
}

export async function saveResumeState(cwd: string, state: ResumeState): Promise<void> {
	try {
		await mkdir(storeDir(cwd), { recursive: true });
		// Atomic write so a crash mid-save can't truncate the resume JSON (a torn file
		// would fail to parse and silently lose the resumable subagent).
		// Repo invariant: bytes that land on disk pass through redactForDisk. The
		// transcript carries tool outputs (bash/read) that may embed credentials;
		// each match is replaced by a `[REDACTED:<type>]` marker that contains no
		// JSON metacharacters, so the serialized state stays valid JSON.
		await writeFileAtomic(stateFile(cwd, state.handle), redactForDisk(JSON.stringify(state)));
	} catch {
		// Best-effort: a persistence failure must not break the spawn/turn.
	}
}

export async function loadResumeState(cwd: string, handle: string): Promise<ResumeState | undefined> {
	try {
		const raw = await readFile(stateFile(cwd, handle), "utf8");
		const parsed = JSON.parse(raw) as ResumeState;
		if (!parsed || !Array.isArray(parsed.messages)) return undefined;
		// Expired: GC the stale state instead of resuming a week-old transcript.
		if (typeof parsed.savedAt === "number" && Date.now() - parsed.savedAt > RESUME_STATE_TTL_MS) {
			await unlink(stateFile(cwd, handle)).catch(() => {});
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

export async function deleteResumeState(cwd: string, handle: string): Promise<void> {
	try {
		await unlink(stateFile(cwd, handle));
	} catch {
		// Already gone / never written — fine.
	}
}

/**
 * Sync list of persisted resume handles (filename stems), for op:"list".
 * Lazily garbage-collects expired states (file mtime older than the TTL) so
 * stale handles from long-dead sessions stop resurfacing.
 */
export function listResumeHandlesSync(cwd: string): string[] {
	try {
		const dir = storeDir(cwd);
		const now = Date.now();
		const live: string[] = [];
		for (const n of readdirSync(dir)) {
			if (!n.endsWith(".json")) continue;
			try {
				if (now - statSync(join(dir, n)).mtimeMs > RESUME_STATE_TTL_MS) {
					unlinkSync(join(dir, n));
					continue;
				}
			} catch {
				// stat/unlink race — treat as live; load re-validates savedAt anyway.
			}
			live.push(n.replace(/\.json$/, ""));
		}
		return live;
	} catch {
		return [];
	}
}
