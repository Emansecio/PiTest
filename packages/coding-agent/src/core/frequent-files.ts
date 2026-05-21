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
				continue;
			}
			if (this.entries.size >= this.maxFiles) {
				this.evictColdest();
			}
			this.entries.set(stat.path, { ...stat });
		}
	}

	private bump(stat: FrequentFileStat, op: FileToolOp, timestamp: number): void {
		if (op === "read") stat.readCount++;
		else if (op === "write") stat.writeCount++;
		else stat.editCount++;
		stat.hits++;
		if (timestamp > stat.lastTouchedAt) stat.lastTouchedAt = timestamp;
		this._coldestDirty = true;
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
	return a.path < b.path;
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
