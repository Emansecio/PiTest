/**
 * Bounded LRU cache of SDK client instances so the underlying HTTP connection
 * pool / keep-alive is reused across turns instead of being recreated on every
 * model request. Recreating an SDK client per turn discards its dispatcher and
 * forces a fresh TCP + TLS handshake on the next request.
 *
 * CORRECTNESS INVARIANT: the cache key is `JSON.stringify(config)`, so it captures
 * every field that defines the client — auth (apiKey/authToken), baseURL, and all
 * resolved headers. Any change to any of these produces a different key, so a
 * client carrying stale credentials or stale headers can never be served.
 *
 * Per-request concerns that are NOT baked into the client (signal, timeout,
 * maxRetries) must be passed to the SDK call separately and excluded from `config`.
 *
 * The bounded LRU caps retained clients so we don't accumulate dispatchers/sockets
 * across many distinct keys (e.g. per-session affinity headers).
 */
export interface ClientCache<T> {
	/** Return the cached client for `config`, or build one via `factory` and cache it. */
	getOrCreate(config: unknown, factory: () => T): T;
	/** Test-only: clear so identity/LRU assertions start from empty. */
	clear(): void;
	readonly size: number;
}

export function createClientCache<T>(maxSize = 32): ClientCache<T> {
	const cache = new Map<string, T>();
	return {
		getOrCreate(config: unknown, factory: () => T): T {
			const key = JSON.stringify(config);
			const existing = cache.get(key);
			if (existing !== undefined) {
				// Refresh recency: re-insert so this key is most-recently-used.
				cache.delete(key);
				cache.set(key, existing);
				return existing;
			}
			const client = factory();
			cache.set(key, client);
			if (cache.size > maxSize) {
				// Evict the least-recently-used entry (first key in insertion order).
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) {
					cache.delete(oldest);
				}
			}
			return client;
		},
		clear(): void {
			cache.clear();
		},
		get size(): number {
			return cache.size;
		},
	};
}
