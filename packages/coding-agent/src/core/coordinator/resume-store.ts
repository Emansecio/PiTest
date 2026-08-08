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

import { createHash } from "node:crypto";
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
	/** Model provider. Optional only for backwards compatibility with legacy resume files. */
	modelProvider?: string;
	/** Model id, re-resolved together with modelProvider on resume. */
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

/**
 * Readable prefix of a handle's filename stem. Capped BELOW the 80-char filename
 * budget so that `${prefix}-${8 hex}` (see {@link resumeStateStem}) still fits in
 * 80 — otherwise a re-sanitize (`slice(0, 80)`) on the composed stem would shave
 * the discriminator back off and reintroduce the very collision it prevents.
 */
const READABLE_STEM_MAX = 71;

function readableStem(handle: string): string {
	return handle.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, READABLE_STEM_MAX) || "task";
}

/**
 * On-disk filename stem for a handle: a readable, filesystem-safe prefix plus a
 * short deterministic discriminator (8 hex of the FULL, pre-truncation handle).
 *
 * `sanitize`-style collapsing (non-`[a-zA-Z0-9_-]` runs → `_`) and an 80-char
 * truncation are BOTH lossy, so two distinct handles ("a b" vs "a_b", or two
 * long names sharing a prefix) could otherwise map to the same file and overwrite
 * each other's persisted transcript. The discriminator keeps the mapping
 * injective while the prefix keeps the filename human-readable. Exported so
 * tests (and any op:"list" consumer) can address the file deterministically. (H21)
 */
export function resumeStateStem(handle: string): string {
	const digest = createHash("sha256").update(handle).digest("hex").slice(0, 8);
	return `${readableStem(handle)}-${digest}`;
}

/**
 * Candidate filenames for a lookup key, most-specific first. A `key` reaching
 * load/delete may be:
 *  - a RAW handle (resume of a live/known handle) → its canonical stem file;
 *  - an already-computed STEM surfaced by op:"list" → matched literally;
 *  - a PRE-discriminator handle from an older Pit whose file is `${sanitize}.json`.
 * The literal form is `sanitize(key).json`, which is idempotent on a stem (a stem
 * is already ≤80 filename-safe chars) and equal to the legacy filename — so both
 * the list→resume round-trip and pre-upgrade files still resolve.
 */
function candidateFiles(cwd: string, key: string): string[] {
	const dir = storeDir(cwd);
	const canonical = resumeStateStem(key);
	const literal = key.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80) || "task";
	const stems = canonical === literal ? [canonical] : [canonical, literal];
	return stems.map((s) => join(dir, `${s}.json`));
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
		const file = join(storeDir(cwd), `${resumeStateStem(state.handle)}.json`);
		await writeFileAtomic(file, redactForDisk(JSON.stringify(state)));
	} catch {
		// Best-effort: a persistence failure must not break the spawn/turn.
	}
}

export async function loadResumeState(cwd: string, handle: string): Promise<ResumeState | undefined> {
	for (const file of candidateFiles(cwd, handle)) {
		try {
			const raw = await readFile(file, "utf8");
			const parsed = JSON.parse(raw) as ResumeState;
			if (!parsed || !Array.isArray(parsed.messages)) continue;
			// Expired: GC the stale state instead of resuming a week-old transcript.
			if (typeof parsed.savedAt === "number" && Date.now() - parsed.savedAt > RESUME_STATE_TTL_MS) {
				await unlink(file).catch(() => {});
				continue;
			}
			return parsed;
		} catch {
			// Missing/corrupt candidate — try the next.
		}
	}
	return undefined;
}

export async function deleteResumeState(cwd: string, handle: string): Promise<void> {
	for (const file of candidateFiles(cwd, handle)) {
		try {
			await unlink(file);
		} catch {
			// Already gone / never written — fine.
		}
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
