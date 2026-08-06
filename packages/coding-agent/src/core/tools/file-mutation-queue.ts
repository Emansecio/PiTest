import { resolve } from "node:path";
import { captureSnapshot } from "../file-snapshots.ts";
import { canonicalPathKey } from "./path-utils.ts";

// Re-export the shared realpath-cache test seams so existing importers of this
// module keep working after the cache moved into path-utils.ts.
export { _realpathCacheSizeForTest, _resetRealpathCacheForTest } from "./path-utils.ts";

const fileMutationQueues = new Map<string, Promise<void>>();

/**
 * Resolve `filePath` to the mutation-queue KEY: the real (symlink-collapsed)
 * path when the file exists, or the resolved-but-unrealized path when it
 * doesn't yet (e.g. `write` about to create a new file) — case-folded on
 * case-insensitive filesystems (win32/darwin) either way, so two callers that
 * reference the same file with different casing (`Foo.ts` vs `foo.ts`) always
 * serialize through the same queue. Delegates to {@link canonicalPathKey}, whose
 * bounded LRU keeps the realpath syscall cached across this per-mutation hot
 * path instead of re-stat'ing on every call (the cache is now shared with the
 * `FileMtimeStore` / read-dedupe callers that key off the same helper).
 *
 * `filePath` MUST already be an absolute path: this resolves purely against
 * `process.cwd()` (via node:path's `resolve`), never a tool's own `cwd`
 * option. Every built-in caller (`edit`/`edit_v2`/`write`) already passes an
 * absolute path computed via `resolveToCwd(path, cwd)` before reaching here —
 * a custom extension tool must do the same (see docs/extensions.md).
 */
function getMutationQueueKey(filePath: string): string {
	return canonicalPathKey(resolve(filePath));
}

/**
 * Upper bound on a single queued mutation. A `writeFile` that never settles (a
 * dead network mount, or a custom `fs` override with a hung promise) would
 * otherwise leave `releaseNext` uncalled forever, wedging every later mutation
 * of the same file behind it. On timeout the caller rejects, but the queue slot
 * remains held until the underlying mutation settles. Releasing it early would
 * allow a second writer to race a still-running first writer. Set generously so
 * no real disk write ever hits it.
 */
const FILE_MUTATION_TIMEOUT_MS = 120_000;

/**
 * Intent to snapshot a file's current bytes as a pre-image before the queued
 * mutation runs. `tool` records which tool triggered the capture (edit/write/
 * undo/...) for `undo`/`/rewind` display.
 */
export interface SnapshotIntent {
	tool: string;
}

/**
 * Options for {@link withFileMutationQueue}. Also accepted as a bare number for
 * backward compatibility (legacy `timeoutMs` positional callers).
 */
export interface MutationQueueOptions {
	timeoutMs?: number;
	/** Abort waiting/racing the operation. The mutation itself is not forcibly
	 * stopped: its queue slot remains held until `fn` settles. */
	signal?: AbortSignal;
	/**
	 * When set, capture the file's current bytes as a pre-image inside the
	 * critical section, BEFORE `fn` runs — atomic with the write `fn` performs.
	 */
	snapshot?: SnapshotIntent;
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 *
 * `optionsOrTimeout` bounds a single operation (`timeoutMs`) so a hung `fn`
 * can't wedge the file's queue indefinitely (see {@link FILE_MUTATION_TIMEOUT_MS}),
 * and optionally requests a pre-image snapshot (`snapshot`) captured atomically
 * with the mutation. A bare number is still accepted as the legacy `timeoutMs`.
 */
export async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
	optionsOrTimeout?: number | MutationQueueOptions,
): Promise<T> {
	const options: MutationQueueOptions =
		typeof optionsOrTimeout === "number" ? { timeoutMs: optionsOrTimeout } : (optionsOrTimeout ?? {});
	const timeoutMs = options.timeoutMs ?? FILE_MUTATION_TIMEOUT_MS;
	const key = getMutationQueueKey(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
	};
	const abortError = () => {
		const reason = options.signal?.reason;
		return reason instanceof Error ? reason : new Error(typeof reason === "string" ? reason : "aborted");
	};
	const abort = options.signal
		? new Promise<never>((_resolve, reject) => {
				if (options.signal?.aborted) reject(abortError());
				else options.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
			})
		: undefined;
	let timer: NodeJS.Timeout | undefined;
	let operation: Promise<T> | undefined;
	try {
		// An aborted waiter must not strand its successor behind currentQueue.
		try {
			await (abort ? Promise.race([currentQueue, abort]) : currentQueue);
		} catch (error) {
			if (options.signal?.aborted) currentQueue.then(release, release);
			throw error;
		}
		if (options.signal?.aborted) throw abortError();
		// Capture the pre-image while we hold the file's lock, before the mutation
		// runs — so nothing can slip a write in between the snapshot and `fn`.
		if (options.snapshot) await captureSnapshot(resolve(filePath), options.snapshot.tool);
		// Convert synchronous throws into a settled operation as well.
		operation = Promise.resolve().then(fn);
		// Timeout/abort only rejects this caller. The physical lock is released by
		// this settlement hook, never by the race below.
		operation.then(release, release);
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`File mutation for ${filePath} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
		return await Promise.race([operation, timeout, ...(abort ? [abort] : [])]);
	} finally {
		if (timer) clearTimeout(timer);
		// Before the mutation starts, there is no real writer to protect. Once
		// operation exists, its settlement hook owns release even after timeout.
		if (!operation && !released) release();
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
	optionsOrTimeout?: number | MutationQueueOptions,
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
		return withFileMutationQueue(ordered[index], () => runAt(index + 1), optionsOrTimeout);
	};
	return runAt(0);
}
