import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
const realpathCache = new Map<string, string>();

// Bound the realpath cache so a long-lived process touching many distinct paths
// can't grow it without limit. Map preserves insertion order, so the oldest
// entry is the first key; a cache hit refreshes recency (delete+set) to make it
// a simple LRU rather than FIFO.
const REALPATH_CACHE_MAX = 2048;

function getMutationQueueKey(filePath: string): string {
	const resolvedPath = resolve(filePath);
	const cached = realpathCache.get(resolvedPath);
	if (cached !== undefined) {
		// Refresh recency.
		realpathCache.delete(resolvedPath);
		realpathCache.set(resolvedPath, cached);
		return cached;
	}
	let resolvedReal: string;
	try {
		resolvedReal = realpathSync.native(resolvedPath);
	} catch {
		resolvedReal = resolvedPath;
	}
	if (realpathCache.size >= REALPATH_CACHE_MAX) {
		const oldest = realpathCache.keys().next().value;
		if (oldest !== undefined) realpathCache.delete(oldest);
	}
	realpathCache.set(resolvedPath, resolvedReal);
	return resolvedReal;
}

/** Test-only: current realpath cache size. */
export function _realpathCacheSizeForTest(): number {
	return realpathCache.size;
}

/** Test-only: clear the realpath cache between tests. */
export function _resetRealpathCacheForTest(): void {
	realpathCache.clear();
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = getMutationQueueKey(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);

	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}
