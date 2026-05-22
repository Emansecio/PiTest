import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();
const realpathCache = new Map<string, string>();

function getMutationQueueKey(filePath: string): string {
	const resolvedPath = resolve(filePath);
	let cached = realpathCache.get(resolvedPath);
	if (cached !== undefined) return cached;
	try {
		cached = realpathSync.native(resolvedPath);
	} catch {
		cached = resolvedPath;
	}
	realpathCache.set(resolvedPath, cached);
	return cached;
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
