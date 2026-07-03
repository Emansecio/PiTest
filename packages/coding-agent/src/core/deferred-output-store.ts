import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactForDisk } from "./secret-redactor.ts";

/**
 * Session-scoped store for tool outputs deferred out of context during
 * compaction. Instead of discarding a large tool output, its full text is
 * kept and replaced in-context by a short placeholder + id; the model
 * re-fetches on demand via the `recall_tool_output` tool.
 *
 * Entries live in memory up to an aggregate cap (default 16MB, override via
 * PIT_DEFERRED_STORE_MEMORY_CAP_BYTES). Above the cap the oldest entries
 * (FIFO by seq) SPILL to a lazily-created temp dir and are freed from memory;
 * `get` falls back memory→disk. Spilled bytes pass through `redactForDisk`
 * (repo invariant for disk artifacts). A spill I/O failure degrades the store
 * to memory-only for the rest of the session — it never aborts the turn.
 * Intra-session only (temp dir removed on dispose).
 */
export interface DeferredOutputStore {
	/** Persist content, return a short retrieval id. */
	put(content: string): string;
	/** Retrieve content by id, or undefined if unknown. */
	get(id: string): string | undefined;
	dispose(): void;
}

/**
 * Aggregate in-memory byte budget before entries spill to disk. Override via
 * PIT_DEFERRED_STORE_MEMORY_CAP_BYTES; a non-negative numeric value is used
 * as-is, anything else falls back to the default. Parsed once at load.
 */
const DEFAULT_MEMORY_CAP_BYTES = 16 * 1024 * 1024;

export function parseDeferredStoreMemoryCap(raw: string | undefined): number {
	if (raw === undefined || raw === "") return DEFAULT_MEMORY_CAP_BYTES;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_MEMORY_CAP_BYTES;
	return Math.floor(parsed);
}

const MEMORY_CAP_BYTES = parseDeferredStoreMemoryCap(
	typeof process !== "undefined" ? process.env.PIT_DEFERRED_STORE_MEMORY_CAP_BYTES : undefined,
);

/** Approximate in-memory footprint of a stored string (2 bytes per UTF-16 code unit). */
function entryBytes(content: string): number {
	return content.length * 2;
}

export interface DeferredOutputStoreOptions {
	/** Aggregate in-memory byte cap before entries spill to disk. Test seam; defaults to the env/module cap. */
	memoryCapBytes?: number;
	/** Directory spilled entries are written to (created lazily on first spill). Test seam; defaults to a fresh temp dir. */
	spillDir?: string;
}

export function createDeferredOutputStore(options?: DeferredOutputStoreOptions): DeferredOutputStore {
	const capBytes = options?.memoryCapBytes ?? MEMORY_CAP_BYTES;
	const memory = new Map<string, string>();
	let memoryBytes = 0;
	let seq = 0;
	// Created lazily on first spill so sessions that stay under the cap never touch the filesystem.
	let dir: string | undefined;
	// Set on the first spill I/O failure: degrade to memory-only for the rest of
	// the session instead of retrying (and re-failing) on every subsequent put.
	let diskUnavailable = false;

	function ensureDir(): string | undefined {
		if (diskUnavailable) return undefined;
		if (dir === undefined) {
			try {
				if (options?.spillDir !== undefined) {
					mkdirSync(options.spillDir, { recursive: true });
					dir = options.spillDir;
				} else {
					dir = mkdtempSync(join(tmpdir(), "pit-deferred-"));
				}
			} catch {
				diskUnavailable = true;
				return undefined;
			}
		}
		return dir;
	}

	/**
	 * Evict the oldest in-memory entries (FIFO — Map iteration is insertion
	 * order, and entries are only ever inserted by put) to disk until the
	 * aggregate footprint is back under the cap. On any I/O failure the store
	 * degrades to memory-only: the entry that failed to spill stays in memory,
	 * so no content is ever lost to a disk error.
	 */
	function spillUntilUnderCap(): void {
		if (memoryBytes <= capBytes) return;
		const target = ensureDir();
		if (target === undefined) return;
		for (const [id, content] of memory) {
			if (memoryBytes <= capBytes) return;
			try {
				// Repo invariant: bytes that land on disk pass through redactForDisk.
				writeFileSync(join(target, `${id}.txt`), redactForDisk(content), "utf8");
			} catch {
				diskUnavailable = true;
				return;
			}
			memory.delete(id);
			memoryBytes -= entryBytes(content);
		}
	}

	return {
		put(content) {
			seq += 1;
			const id = `d${seq}`;
			memory.set(id, content);
			memoryBytes += entryBytes(content);
			spillUntilUnderCap();
			return id;
		},
		get(id) {
			// Guard against path traversal: ids are `d<number>` only.
			if (!/^d\d+$/.test(id)) return undefined;
			const cached = memory.get(id);
			if (cached !== undefined) return cached;
			if (dir === undefined) return undefined;
			const path = join(dir, `${id}.txt`);
			if (!existsSync(path)) return undefined;
			try {
				return readFileSync(path, "utf8");
			} catch {
				return undefined;
			}
		},
		dispose() {
			memory.clear();
			memoryBytes = 0;
			if (dir !== undefined) {
				try {
					rmSync(dir, { recursive: true, force: true });
				} catch {
					// best-effort
				}
				dir = undefined;
			}
		},
	};
}

let currentStore: DeferredOutputStore | undefined;
export function setCurrentDeferredOutputStore(store: DeferredOutputStore | undefined): void {
	currentStore = store;
}
export function getCurrentDeferredOutputStore(): DeferredOutputStore | undefined {
	return currentStore;
}
