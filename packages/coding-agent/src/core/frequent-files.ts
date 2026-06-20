/**
 * Frequent-files tracker.
 *
 * Counts per-file read/write/edit operations during a session and exposes the
 * top-N hottest files. Inspired by the "Frequent Files in Prompt" pattern from
 * Vix — the rationale is that files the agent has touched recently are likely
 * to be relevant to the next action, so surfacing them in the system prompt
 * keeps the model anchored without forcing the user to re-state context.
 *
 * Pure (no I/O). Bounded by `maxFiles` to prevent pathological growth on
 * sessions that touch huge file trees; entries beyond the cap are evicted by
 * "least recent + lowest hits" (a tiny LRU+LFU hybrid).
 */

import { execFile } from "node:child_process";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { FileToolOp } from "./compaction/utils.ts";

export interface FrequentFileStat {
	path: string;
	readCount: number;
	writeCount: number;
	editCount: number;
	/** Total of all op counts. Maintained on `record` to keep `getTop` O(n log n). */
	hits: number;
	/** Epoch ms of the most recent op. Used as a tiebreaker in `getTop`. */
	lastTouchedAt: number;
}

export interface FrequentFilesTrackerOptions {
	/** Hard cap on tracked paths. Evicted entries are the coldest. Default: 256. */
	maxFiles?: number;
}

export interface GetTopOptions {
	/** Minimum hit count required for a file to surface. Default: 1. */
	minHits?: number;
	/** Maximum number of entries to return. Default: 10. */
	topN?: number;
}

const DEFAULT_MAX_FILES = 256;
const DEFAULT_TOP_N = 10;
const DEFAULT_MIN_HITS = 1;

export class FrequentFilesTracker {
	private readonly entries = new Map<string, FrequentFileStat>();
	private readonly maxFiles: number;
	private _coldestPath: string | undefined;
	private _coldestHits = Number.POSITIVE_INFINITY;
	private _coldestTs = Number.POSITIVE_INFINITY;
	private _coldestDirty = true;

	constructor(options?: FrequentFilesTrackerOptions) {
		const cap = options?.maxFiles;
		this.maxFiles = typeof cap === "number" && cap > 0 ? Math.floor(cap) : DEFAULT_MAX_FILES;
	}

	/**
	 * Record one file operation. Increments the op-specific counter and updates
	 * the totals. When the tracker is at capacity for a new path, the coldest
	 * existing entry is evicted (lowest hits, then oldest `lastTouchedAt`).
	 */
	record(path: string, op: FileToolOp, timestamp: number = Date.now()): void {
		if (!path) return;
		const existing = this.entries.get(path);
		if (existing) {
			this.bump(existing, op, timestamp);
			return;
		}
		if (this.entries.size >= this.maxFiles) {
			this.evictColdest();
		}
		const stat: FrequentFileStat = {
			path,
			readCount: 0,
			writeCount: 0,
			editCount: 0,
			hits: 0,
			lastTouchedAt: timestamp,
		};
		this.bump(stat, op, timestamp);
		this.entries.set(path, stat);
		// A fresh entry has low hits and may become the coldest. If the cached
		// coldest is still valid (not dirty), update it incrementally in O(1):
		// adopt the new entry only when it is colder (fewer hits, or equal hits +
		// older lastTouchedAt) or when there is no cached coldest yet. Otherwise
		// the cached coldest is unchanged and still correct, so leave dirty alone.
		// When already dirty, the cached values are stale — defer to the lazy
		// recompute in evictColdest() rather than comparing against stale state.
		if (!this._coldestDirty) {
			if (
				this._coldestPath === undefined ||
				stat.hits < this._coldestHits ||
				(stat.hits === this._coldestHits && stat.lastTouchedAt < this._coldestTs)
			) {
				this._coldestPath = path;
				this._coldestHits = stat.hits;
				this._coldestTs = stat.lastTouchedAt;
			}
		}
	}

	/**
	 * Return the top-N files sorted by descending hits, breaking ties on
	 * `lastTouchedAt` (more recent first) then `path` (lexicographic).
	 * Uses a bounded min-heap for O(n log k) instead of O(n log n).
	 */
	getTop(options?: GetTopOptions): FrequentFileStat[] {
		const topN = options?.topN ?? DEFAULT_TOP_N;
		if (topN <= 0) return [];
		const minHits = options?.minHits ?? DEFAULT_MIN_HITS;

		const heap: FrequentFileStat[] = [];
		for (const stat of this.entries.values()) {
			if (stat.hits < minHits) continue;
			if (heap.length < topN) {
				heap.push(stat);
				if (heap.length === topN) buildMinHeap(heap);
			} else if (heapGt(stat, heap[0])) {
				heap[0] = stat;
				siftDown(heap, 0);
			}
		}
		heap.sort(descCompare);
		return heap;
	}

	/** Number of tracked paths. */
	size(): number {
		return this.entries.size;
	}

	/** Drop all entries. */
	reset(): void {
		this.entries.clear();
		this._coldestDirty = true;
	}

	/** Merge another tracker's stats into this one. Used for session-resume scenarios. */
	merge(other: FrequentFilesTracker): void {
		for (const stat of other.entries.values()) {
			const existing = this.entries.get(stat.path);
			if (existing) {
				existing.readCount += stat.readCount;
				existing.writeCount += stat.writeCount;
				existing.editCount += stat.editCount;
				existing.hits += stat.hits;
				if (stat.lastTouchedAt > existing.lastTouchedAt) {
					existing.lastTouchedAt = stat.lastTouchedAt;
				}
				// Bumping an existing entry's hits can move it off being coldest (and
				// raises the floor); the cached coldest is now stale. Mirror loadSnapshot.
				this._coldestDirty = true;
				continue;
			}
			if (this.entries.size >= this.maxFiles) {
				this.evictColdest();
			}
			this.entries.set(stat.path, { ...stat });
			// A freshly-inserted entry may be the new coldest; force a recompute on the
			// next eviction rather than trusting the stale cached coldest.
			this._coldestDirty = true;
		}
	}

	/** Serialize the current entries to a versioned snapshot, safe to JSON-encode. */
	toSnapshot(): FrequentFilesSnapshot {
		return {
			version: FREQ_SNAPSHOT_VERSION,
			savedAt: Date.now(),
			entries: Array.from(this.entries.values(), (s) => ({ ...s })),
		};
	}

	/**
	 * Hydrate from a snapshot using merge semantics so callers can compose with
	 * an existing in-memory tracker. Silently ignores entries with the wrong
	 * shape — the snapshot file is best-effort, not load-bearing.
	 */
	loadSnapshot(snapshot: FrequentFilesSnapshot | undefined): void {
		if (!snapshot || snapshot.version !== FREQ_SNAPSHOT_VERSION) return;
		if (!Array.isArray(snapshot.entries)) return;
		for (const raw of snapshot.entries) {
			if (!raw || typeof raw.path !== "string" || raw.path.length === 0) continue;
			const readCount = toNonNegInt(raw.readCount);
			const writeCount = toNonNegInt(raw.writeCount);
			const editCount = toNonNegInt(raw.editCount);
			const hits = toNonNegInt(raw.hits);
			if (hits === 0) continue;
			const lastTouchedAt =
				typeof raw.lastTouchedAt === "number" && Number.isFinite(raw.lastTouchedAt) ? raw.lastTouchedAt : 0;
			const existing = this.entries.get(raw.path);
			if (existing) {
				existing.readCount += readCount;
				existing.writeCount += writeCount;
				existing.editCount += editCount;
				existing.hits += hits;
				if (lastTouchedAt > existing.lastTouchedAt) existing.lastTouchedAt = lastTouchedAt;
				this._coldestDirty = true;
				continue;
			}
			if (this.entries.size >= this.maxFiles) this.evictColdest();
			this.entries.set(raw.path, { path: raw.path, readCount, writeCount, editCount, hits, lastTouchedAt });
			this._coldestDirty = true;
		}
	}

	private bump(stat: FrequentFileStat, op: FileToolOp, timestamp: number): void {
		if (op === "read") stat.readCount++;
		else if (op === "write") stat.writeCount++;
		else stat.editCount++;
		stat.hits++;
		if (timestamp > stat.lastTouchedAt) stat.lastTouchedAt = timestamp;
		// A bump only INCREASES hits (and never decreases lastTouchedAt), so the
		// entry can only move AWAY from being coldest. The cached coldest stays
		// valid unless the entry we just bumped IS the current coldest — then its
		// hits rose and another entry may now be colder, so force a recompute.
		if (stat.path === this._coldestPath) this._coldestDirty = true;
	}

	private evictColdest(): void {
		if (this._coldestDirty) this.recomputeColdest();
		if (this._coldestPath !== undefined) {
			this.entries.delete(this._coldestPath);
			this._coldestDirty = true;
		}
	}

	private recomputeColdest(): void {
		this._coldestHits = Number.POSITIVE_INFINITY;
		this._coldestTs = Number.POSITIVE_INFINITY;
		this._coldestPath = undefined;
		for (const [path, stat] of this.entries) {
			if (
				stat.hits < this._coldestHits ||
				(stat.hits === this._coldestHits && stat.lastTouchedAt < this._coldestTs)
			) {
				this._coldestHits = stat.hits;
				this._coldestTs = stat.lastTouchedAt;
				this._coldestPath = path;
			}
		}
		this._coldestDirty = false;
	}
}

// --- Cross-session persistence ----------------------------------------------

const FREQ_SNAPSHOT_VERSION = 1 as const;

export interface FrequentFilesSnapshot {
	version: typeof FREQ_SNAPSHOT_VERSION;
	/** Epoch ms of the producing serialization. Used for staleness/debug. */
	savedAt: number;
	entries: FrequentFileStat[];
}

function toNonNegInt(raw: unknown): number {
	if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
	const n = Math.floor(raw);
	return n > 0 ? n : 0;
}

/**
 * Best-effort read of a snapshot from disk. Returns `undefined` on any failure
 * (missing file, parse error, version mismatch) — callers MUST treat the
 * snapshot as advisory, not load-bearing.
 */
export function loadFrequentFilesSnapshot(filePath: string): FrequentFilesSnapshot | undefined {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const candidate = parsed as Partial<FrequentFilesSnapshot>;
	if (candidate.version !== FREQ_SNAPSHOT_VERSION) return undefined;
	if (!Array.isArray(candidate.entries)) return undefined;
	const savedAt = typeof candidate.savedAt === "number" && Number.isFinite(candidate.savedAt) ? candidate.savedAt : 0;
	return { version: FREQ_SNAPSHOT_VERSION, savedAt, entries: candidate.entries as FrequentFileStat[] };
}

/**
 * Atomic snapshot write: writes to `<filePath>.tmp` + fsync + rename, so a
 * crash mid-write leaves the prior snapshot intact. Creates parent dirs.
 * Throws — caller decides whether to swallow (boot/dispose path: yes).
 */
export function saveFrequentFilesSnapshot(filePath: string, snapshot: FrequentFilesSnapshot): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	const payload = JSON.stringify(snapshot);
	const fd = openSync(tmpPath, "w");
	try {
		writeSync(fd, payload);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmpPath, filePath);
	} catch (err) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// best effort
		}
		throw err;
	}
}

/** Default project-local snapshot file. Mirrors `defaultBankPath` from hindsight. */
export function defaultFrequentFilesPath(cwd: string): string {
	return join(cwd, ".pit", "frequent-files.json");
}

// --- Min-heap helpers for bounded top-N selection ---

function descCompare(a: FrequentFileStat, b: FrequentFileStat): number {
	if (b.hits !== a.hits) return b.hits - a.hits;
	if (b.lastTouchedAt !== a.lastTouchedAt) return b.lastTouchedAt - a.lastTouchedAt;
	return a.path.localeCompare(b.path);
}

/** Returns true when `a` should rank higher than `b` (more hits, more recent). */
function heapGt(a: FrequentFileStat, b: FrequentFileStat): boolean {
	if (a.hits !== b.hits) return a.hits > b.hits;
	if (a.lastTouchedAt !== b.lastTouchedAt) return a.lastTouchedAt > b.lastTouchedAt;
	// Mirror descCompare's path tiebreak (localeCompare, not raw `<`) so heap
	// eviction and the final sort agree at the topN boundary — otherwise a tie
	// in both hits and lastTouchedAt can evict the entry descCompare ranks higher.
	return a.path.localeCompare(b.path) < 0;
}

/** Min-heap by ranking (root = weakest element = eviction candidate). */
function siftDown(heap: FrequentFileStat[], i: number): void {
	const n = heap.length;
	while (true) {
		let smallest = i;
		const l = 2 * i + 1;
		const r = 2 * i + 2;
		if (l < n && heapGt(heap[smallest], heap[l])) smallest = l;
		if (r < n && heapGt(heap[smallest], heap[r])) smallest = r;
		if (smallest === i) break;
		const tmp = heap[i];
		heap[i] = heap[smallest];
		heap[smallest] = tmp;
		i = smallest;
	}
}

function buildMinHeap(heap: FrequentFileStat[]): void {
	for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(heap, i);
}

/**
 * Render a list of frequent-files stats as a system-prompt section. Returns
 * the empty string when the input is empty so callers can concat unconditionally.
 *
 * Format mirrors PiT's existing XML-ish section conventions
 * (`<frequent_files>` ... `</frequent_files>`) so it slots cleanly next to
 * `<project_context>` and the skills block.
 */
export function formatFrequentFilesForPrompt(top: FrequentFileStat[]): string {
	if (top.length === 0) return "";
	const lines: string[] = ["<frequent_files>"];
	lines.push(
		"Files the agent has touched most often in this session. Prefer reading these before broad search when relevant.",
	);
	for (const stat of top) {
		const ops: string[] = [];
		if (stat.readCount > 0) ops.push(`read×${stat.readCount}`);
		if (stat.editCount > 0) ops.push(`edit×${stat.editCount}`);
		if (stat.writeCount > 0) ops.push(`write×${stat.writeCount}`);
		lines.push(`- ${stat.path} (${ops.join(", ")})`);
	}
	lines.push("</frequent_files>");
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Repo-wide "frequent files" computation (git log + mtime fallback).
// Separate from the session tracker above: the tracker counts what THIS session
// has touched, this function answers "what does the project itself touch most
// often" — used at session boot to seed the system prompt with recent hot files.
// ---------------------------------------------------------------------------

export interface FrequentFile {
	path: string;
	count: number;
	source: "git" | "mtime";
}

export interface FrequentFilesOptions {
	cwd: string;
	/** Max results to return. Default: 10. */
	limit?: number;
	/** Time window for git log scan. Default: 30. */
	sinceDays?: number;
	/** Caller-supplied abort signal. Aborts the git subprocess and walks. */
	signal?: AbortSignal;
	/** Hard cap on the git subprocess wall clock. Default: 2000ms. */
	gitTimeoutMs?: number;
}

const FREQ_DEFAULT_LIMIT = 10;
const FREQ_DEFAULT_SINCE_DAYS = 30;
const FREQ_DEFAULT_GIT_TIMEOUT_MS = 2000;
const FREQ_FS_FALLBACK_MAX_ENTRIES = 5000;
const FREQ_FS_SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".turbo",
	".cache",
	".pit",
	"coverage",
	"target",
	".venv",
	"venv",
	"__pycache__",
]);

/**
 * Compute the project's hottest files in the recent past.
 *
 * Strategy:
 *  1. `git log --name-only --since=<N>.days.ago` → count per file → filter to
 *     paths that still exist → top-N by count.
 *  2. On git failure / timeout / zero results, fall back to walking the cwd
 *     (skipping vendor + build dirs) and sorting by mtime desc.
 *
 * The git call is wrapped in a hard wall-clock timeout because monorepos with
 * deep histories can stall here; the mtime walk is bounded by both an entry
 * cap and the same abort signal.
 */
export async function computeFrequentFiles(opts: FrequentFilesOptions): Promise<FrequentFile[]> {
	const limit = opts.limit ?? FREQ_DEFAULT_LIMIT;
	const sinceDays = opts.sinceDays ?? FREQ_DEFAULT_SINCE_DAYS;
	const gitTimeoutMs = opts.gitTimeoutMs ?? FREQ_DEFAULT_GIT_TIMEOUT_MS;
	if (limit <= 0) return [];

	const gitResult = await runGitLog(opts.cwd, sinceDays, gitTimeoutMs, opts.signal).catch(() => undefined);
	if (gitResult && gitResult.length > 0) {
		const filtered = await filterExisting(opts.cwd, gitResult, limit);
		if (filtered.length > 0) return filtered;
	}

	return walkMtimeFallback(opts.cwd, limit, opts.signal);
}

async function runGitLog(
	cwd: string,
	sinceDays: number,
	timeoutMs: number,
	signal: AbortSignal | undefined,
): Promise<Array<{ path: string; count: number }> | undefined> {
	const counts = new Map<string, number>();
	// `execFile`'s callback only fires after the child has fully exited, so
	// resolving/rejecting from inside it (and ONLY from inside it) guarantees
	// the child no longer holds `cwd`. On abort/timeout we kill the child but
	// wait for the callback before settling — otherwise on Windows the cwd
	// stays locked just long enough for `rmSync(tempDir)` in tests to EBUSY.
	let aborted = false;
	let timedOut = false;
	await new Promise<void>((resolve, reject) => {
		const child = execFile(
			"git",
			["log", "--pretty=format:", "--name-only", `--since=${sinceDays}.days.ago`],
			{ cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(error, stdout) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				if (aborted) {
					reject(new Error("aborted"));
					return;
				}
				if (timedOut) {
					reject(new Error("git log timed out"));
					return;
				}
				if (error) {
					// `git log` on a non-repo or with no commits exits non-zero; treat as
					// "no data" and let the caller fall back to mtime.
					resolve();
					return;
				}
				for (const rawLine of stdout.split("\n")) {
					const line = rawLine.trim();
					if (!line) continue;
					counts.set(line, (counts.get(line) ?? 0) + 1);
				}
				resolve();
			},
		);
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		const onAbort = () => {
			aborted = true;
			child.kill();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	if (counts.size === 0) return undefined;
	return Array.from(counts.entries())
		.map(([path, count]) => ({ path, count }))
		.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
}

async function filterExisting(
	cwd: string,
	ranked: Array<{ path: string; count: number }>,
	limit: number,
): Promise<FrequentFile[]> {
	const out: FrequentFile[] = [];
	// Iterate in descending order; stop as soon as we have `limit` survivors. This
	// keeps the existence check bounded — a 10k-file history won't trigger 10k stats.
	for (const entry of ranked) {
		if (out.length >= limit) break;
		const abs = join(cwd, entry.path);
		const exists = await stat(abs).then(
			(s) => s.isFile(),
			() => false,
		);
		if (exists) {
			out.push({ path: entry.path, count: entry.count, source: "git" });
		}
	}
	return out;
}

async function walkMtimeFallback(cwd: string, limit: number, signal: AbortSignal | undefined): Promise<FrequentFile[]> {
	const collected: Array<{ path: string; mtimeMs: number }> = [];
	const queue: string[] = [cwd];
	let visited = 0;
	while (queue.length > 0 && visited < FREQ_FS_FALLBACK_MAX_ENTRIES) {
		if (signal?.aborted) break;
		const dir = queue.shift()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (visited >= FREQ_FS_FALLBACK_MAX_ENTRIES) break;
			visited++;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (FREQ_FS_SKIP_DIRS.has(entry.name)) continue;
				if (entry.name.startsWith(".") && entry.name !== ".pit") continue;
				queue.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			try {
				const s = await stat(full);
				collected.push({ path: full, mtimeMs: s.mtimeMs });
			} catch {
				// Permission or vanish — skip silently.
			}
		}
	}
	collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const top = collected.slice(0, limit);
	return top.map((entry) => {
		const rel = relative(cwd, entry.path);
		// Normalize Windows backslashes so prompt output is consistent across platforms.
		const normalized = rel.split(sep).join("/");
		return { path: normalized.length > 0 ? normalized : entry.path, count: 1, source: "mtime" as const };
	});
}

/**
 * Render the boot-time frequent-files list for the system prompt. Distinct
 * from `formatFrequentFilesForPrompt` (session tracker) — this surfaces repo-
 * level recency from git history, not per-session tool usage. Returns empty
 * string when the list is empty so callers can concat unconditionally.
 */
export function formatFrequentFilesIndexForPrompt(files: FrequentFile[]): string {
	if (files.length === 0) return "";
	const source = files[0]?.source ?? "git";
	const headline =
		source === "git"
			? `Files most edited recently (top ${files.length}):`
			: `Files most recently modified on disk (top ${files.length}):`;
	const lines: string[] = ["<frequent_files>", headline];
	for (const f of files) {
		const suffix = f.source === "git" ? ` (${f.count} commit${f.count === 1 ? "" : "s"})` : "";
		lines.push(`${f.path}${suffix}`);
	}
	lines.push("</frequent_files>");
	return lines.join("\n");
}
