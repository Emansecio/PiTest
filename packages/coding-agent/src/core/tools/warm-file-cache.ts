/**
 * In-memory, per-process warm cache for file content prefetched by the code-graph
 * prefetcher (`built-ins/graph-prefetch-extension.ts` — proposal P6, see
 * `docs/proposals/2026-07-22-propostas-fronteira.md`).
 *
 * Holds the exact bytes a `read` would otherwise have gone to disk for, keyed by
 * canonical path (see `path-utils.ts`'s `canonicalPathKey` — the same identity
 * `ReadDedupeStore` and `FileMtimeStore` use), so a later `read` of that same
 * file can skip its `ops.readFile` when the content is still fresh. "Fresh"
 * means the CURRENT on-disk stat matches the entry's `(mtimeMs, size)` pair
 * exactly — mtime alone is not a content identity (same reasoning as the
 * external-edit sentinel's baseline), so both must agree or the caller treats
 * it as a miss and falls through to a normal disk read. A miss is silent and
 * free: it costs nothing beyond the read the tool was going to do anyway.
 *
 * Zero tokens by construction: nothing in this module ever touches a tool
 * result or the model's context — it only short-circuits the I/O half of a
 * read the model would have triggered on its own. The read tool still renders
 * its usual (possibly truncated/deduped/anchored) output from whatever buffer
 * it ends up with, warm or cold.
 *
 * Bounded like `ReadDedupeStore`: an aggregate byte budget (primary) plus an
 * entry-count cap (secondary), LRU-evicted, oldest first. Deliberately tiny —
 * this warms a handful of grade-1 graph neighbors per turn, not a general
 * file cache.
 */
import { canonicalPathKey } from "./path-utils.ts";

/** Default max resident entries — a handful of graph neighbors, not a general cache. */
export const WARM_FILE_CACHE_MAX_ENTRIES = 32;
/** Default aggregate byte budget across all resident entries. */
export const WARM_FILE_CACHE_MAX_BYTES = 8 * 1024 * 1024;

export interface WarmFileCacheEntry {
	/** Exact file content (decoded utf-8) as of `mtimeMs`/`size`. */
	content: string;
	/** mtime (ms) observed when this entry was warmed. A hit requires the live stat to match exactly. */
	mtimeMs: number;
	/** Byte size observed when this entry was warmed — second discriminator (mtime alone is not a content identity). */
	size: number;
}

interface StoredEntry extends WarmFileCacheEntry {
	/** Cached byte-cost charge for this entry (key + content), so eviction never re-measures. */
	bytes: number;
}

export class WarmFileCache {
	private readonly seen = new Map<string, StoredEntry>();
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private totalBytes = 0;

	constructor(maxEntries: number = WARM_FILE_CACHE_MAX_ENTRIES, maxBytes: number = WARM_FILE_CACHE_MAX_BYTES) {
		this.maxEntries = Math.max(1, maxEntries);
		this.maxBytes = Math.max(1, maxBytes);
	}

	/**
	 * Resident entry for this path, or undefined. Refreshes LRU recency (a hit
	 * keeps this file "hot") — this is the method the read tool's consumption
	 * path should call. Use {@link peek} instead when recency must not change
	 * (e.g. a prefetcher checking "is this already warm" before re-reading it).
	 */
	get(absolutePath: string): WarmFileCacheEntry | undefined {
		const key = canonicalPathKey(absolutePath);
		const entry = this.seen.get(key);
		if (!entry) return undefined;
		this.seen.delete(key);
		this.seen.set(key, entry);
		return { content: entry.content, mtimeMs: entry.mtimeMs, size: entry.size };
	}

	/** Resident entry for this path without affecting recency. */
	peek(absolutePath: string): WarmFileCacheEntry | undefined {
		const entry = this.seen.get(canonicalPathKey(absolutePath));
		return entry ? { content: entry.content, mtimeMs: entry.mtimeMs, size: entry.size } : undefined;
	}

	/** True when `absolutePath` already has a resident entry (any mtime) — lets the prefetcher skip re-warming it. */
	has(absolutePath: string): boolean {
		return this.seen.has(canonicalPathKey(absolutePath));
	}

	/** Warm (or refresh) an entry. Re-inserting refreshes LRU recency. */
	set(absolutePath: string, entry: WarmFileCacheEntry): void {
		const key = canonicalPathKey(absolutePath);
		const prev = this.seen.get(key);
		if (prev) this.totalBytes -= prev.bytes;
		this.seen.delete(key);
		const bytes = key.length + entry.content.length;
		this.seen.set(key, { ...entry, bytes });
		this.totalBytes += bytes;
		this.evict();
	}

	/**
	 * LRU-evict the oldest entries until both bounds fit. Never evicts down to
	 * zero — a single oversized entry is tolerated rather than leaving the cache
	 * unable to hold even one file (mirrors `ReadDedupeStore.evict`).
	 */
	private evict(): void {
		while ((this.seen.size > this.maxEntries || this.totalBytes > this.maxBytes) && this.seen.size > 1) {
			const oldest = this.seen.keys().next().value;
			if (oldest === undefined) break;
			const entry = this.seen.get(oldest);
			if (entry) this.totalBytes -= entry.bytes;
			this.seen.delete(oldest);
		}
	}

	/** Current resident entry count (test/debug only). */
	get size(): number {
		return this.seen.size;
	}

	/** Forget everything (explicit reset only). */
	clear(): void {
		this.seen.clear();
		this.totalBytes = 0;
	}
}
