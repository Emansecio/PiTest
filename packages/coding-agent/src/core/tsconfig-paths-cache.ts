import { statSync } from "node:fs";
import type { TsconfigPathsResult } from "./project-config-context.ts";

const MAX_CACHE_ENTRIES = 64;

interface CacheEntry {
	mtimeMs: number;
	result: TsconfigPathsResult | undefined;
}

const cache = new Map<string, CacheEntry>();
const keyOrder: string[] = [];

function touchKey(key: string): void {
	const idx = keyOrder.indexOf(key);
	if (idx >= 0) keyOrder.splice(idx, 1);
	keyOrder.push(key);
	while (keyOrder.length > MAX_CACHE_ENTRIES) {
		const evict = keyOrder.shift();
		if (evict) cache.delete(evict);
	}
}

/** Cached wrapper around resolvePathsFromConfig — keyed by config path + mtime. */
export function getCachedTsconfigPaths(
	absConfigPath: string,
	resolve: () => TsconfigPathsResult | undefined,
): TsconfigPathsResult | undefined {
	let mtimeMs = 0;
	try {
		mtimeMs = statSync(absConfigPath).mtimeMs;
	} catch {
		return resolve();
	}
	const key = absConfigPath;
	const hit = cache.get(key);
	if (hit && hit.mtimeMs === mtimeMs) {
		touchKey(key);
		return hit.result;
	}
	const result = resolve();
	cache.set(key, { mtimeMs, result });
	touchKey(key);
	return result;
}

/** Test-only: clear the LRU between cases. */
export function clearTsconfigPathsCacheForTest(): void {
	cache.clear();
	keyOrder.length = 0;
}
