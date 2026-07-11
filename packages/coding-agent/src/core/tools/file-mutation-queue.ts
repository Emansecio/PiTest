import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { FS_CASE_INSENSITIVE } from "./path-utils.ts";

const fileMutationQueues = new Map<string, Promise<void>>();
const realpathCache = new Map<string, string>();

// Bound the realpath cache so a long-lived process touching many distinct paths
// can't grow it without limit. Map preserves insertion order, so the oldest
// entry is the first key; a cache hit refreshes recency (delete+set) to make it
// a simple LRU rather than FIFO.
const REALPATH_CACHE_MAX = 2048;

/**
 * Resolve `filePath` to the mutation-queue KEY: the real (symlink-collapsed)
 * path when the file exists, or the resolved-but-unrealized path when it
 * doesn't yet (e.g. `write` about to create a new file) — case-folded on
 * case-insensitive filesystems (win32/darwin) either way, so two callers that
 * reference the same file with different casing (`Foo.ts` vs `foo.ts`) always
 * serialize through the same queue. Same "canonical key" contract as
 * {@link canonicalPathKey} in path-utils.ts; reimplemented locally (rather
 * than calling it) so the realpath syscall stays cached across this
 * per-mutation hot path instead of re-stat'ing on every call.
 *
 * `filePath` MUST already be an absolute path: this resolves purely against
 * `process.cwd()` (via node:path's `resolve`), never a tool's own `cwd`
 * option. Every built-in caller (`edit`/`edit_v2`/`write`) already passes an
 * absolute path computed via `resolveToCwd(path, cwd)` before reaching here —
 * a custom extension tool must do the same (see docs/extensions.md).
 */
function getMutationQueueKey(filePath: string): string {
	const resolvedPath = resolve(filePath);
	const lookupKey = FS_CASE_INSENSITIVE ? resolvedPath.toLowerCase() : resolvedPath;
	const cached = realpathCache.get(lookupKey);
	if (cached !== undefined) {
		// Refresh recency.
		realpathCache.delete(lookupKey);
		realpathCache.set(lookupKey, cached);
		return cached;
	}
	let resolvedReal: string;
	try {
		resolvedReal = realpathSync.native(resolvedPath);
	} catch {
		// Non-existent / unreadable path — key off the resolved input.
		resolvedReal = resolvedPath;
	}
	const key = FS_CASE_INSENSITIVE ? resolvedReal.toLowerCase() : resolvedReal;
	if (realpathCache.size >= REALPATH_CACHE_MAX) {
		const oldest = realpathCache.keys().next().value;
		if (oldest !== undefined) realpathCache.delete(oldest);
	}
	realpathCache.set(lookupKey, key);
	return key;
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
 * Upper bound on a single queued mutation. A `writeFile` that never settles (a
 * dead network mount, or a custom `fs` override with a hung promise) would
 * otherwise leave `releaseNext` uncalled forever, wedging every later mutation
 * of the same file behind it. On timeout the current op rejects AND the queue
 * slot is released, so subsequent mutations proceed — the hung write may still
 * land later, which is the lesser evil versus a permanently stuck file. Set
 * generously so no real disk write ever hits it.
 */
const FILE_MUTATION_TIMEOUT_MS = 120_000;

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 *
 * `timeoutMs` bounds a single operation so a hung `fn` can't wedge the file's
 * queue indefinitely (see {@link FILE_MUTATION_TIMEOUT_MS}); pass a smaller
 * value in tests that deliberately exercise the timeout path.
 */
export async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
	timeoutMs: number = FILE_MUTATION_TIMEOUT_MS,
): Promise<T> {
	const key = getMutationQueueKey(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);

	await currentQueue;
	let timer: NodeJS.Timeout | undefined;
	try {
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`File mutation for ${filePath} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
		return await Promise.race([fn(), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}

/**
 * Serialize mutations across multiple files, acquiring per-file queues in
 * lexicographic key order to avoid deadlock when two multi-file ops overlap
 * (A locks foo then bar; B locks bar then foo).
 *
 * Empty `filePaths` runs `fn` immediately (no queue). Duplicate paths collapse
 * to one queue slot.
 */
export async function withFileMutationQueues<T>(
	filePaths: readonly string[],
	fn: () => Promise<T>,
	timeoutMs: number = FILE_MUTATION_TIMEOUT_MS,
): Promise<T> {
	if (filePaths.length === 0) return fn();
	const byKey = new Map<string, string>();
	for (const filePath of filePaths) {
		const key = getMutationQueueKey(filePath);
		if (!byKey.has(key)) byKey.set(key, filePath);
	}
	const ordered = [...byKey.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([, path]) => path);

	const runAt = async (index: number): Promise<T> => {
		if (index >= ordered.length) return fn();
		return withFileMutationQueue(ordered[index], () => runAt(index + 1), timeoutMs);
	};
	return runAt(0);
}
