import { describe, expect, it } from "vitest";
import { createClientCache } from "../src/utils/client-cache.ts";

describe("createClientCache", () => {
	it("reuses the client for an identical config (preserves keep-alive)", () => {
		const cache = createClientCache<{ id: number }>();
		let built = 0;
		const cfg = { apiKey: "k", baseURL: "u", defaultHeaders: { a: "1" } };
		const a = cache.getOrCreate(cfg, () => ({ id: ++built }));
		const b = cache.getOrCreate({ apiKey: "k", baseURL: "u", defaultHeaders: { a: "1" } }, () => ({ id: ++built }));
		expect(b).toBe(a);
		expect(built).toBe(1);
	});

	it("builds a new client when any config field changes (never serves stale)", () => {
		const cache = createClientCache<{ id: number }>();
		let built = 0;
		const base = { baseURL: "u", defaultHeaders: {} };
		const a = cache.getOrCreate({ ...base, apiKey: "old" }, () => ({ id: ++built }));
		const b = cache.getOrCreate({ ...base, apiKey: "new" }, () => ({ id: ++built }));
		const c = cache.getOrCreate({ ...base, apiKey: "new", defaultHeaders: { x: "y" } }, () => ({ id: ++built }));
		expect(b).not.toBe(a);
		expect(c).not.toBe(b);
		expect(built).toBe(3);
	});

	it("bounds the cache (LRU eviction) so dispatchers do not accumulate", () => {
		const cache = createClientCache<{ i: number }>(4);
		const mk = (i: number) => cache.getOrCreate({ k: i }, () => ({ i }));
		const first = mk(0);
		for (let i = 1; i <= 4; i++) {
			mk(i); // size grows to cap then evicts oldest (k:0)
		}
		expect(cache.size).toBe(4);
		const firstAgain = mk(0);
		expect(firstAgain).not.toBe(first); // was evicted → rebuilt
	});

	it("refreshes recency so a touched entry survives eviction", () => {
		const cache = createClientCache<{ i: number }>(4);
		const keep = cache.getOrCreate({ k: "keep" }, () => ({ i: -1 }));
		cache.getOrCreate({ k: "a" }, () => ({ i: 1 }));
		cache.getOrCreate({ k: "b" }, () => ({ i: 2 }));
		cache.getOrCreate({ k: "c" }, () => ({ i: 3 })); // size 4, keep is oldest
		// Touch keep → most-recent. Then insert one more: oldest ("a") is evicted, not keep.
		expect(cache.getOrCreate({ k: "keep" }, () => ({ i: -99 }))).toBe(keep);
		cache.getOrCreate({ k: "d" }, () => ({ i: 4 }));
		expect(cache.getOrCreate({ k: "keep" }, () => ({ i: -99 }))).toBe(keep);
		// "a" was the LRU and should have been rebuilt now.
		const aRebuilt = cache.getOrCreate({ k: "a" }, () => ({ i: 111 }));
		expect(aRebuilt.i).toBe(111);
	});

	it("clear() empties the cache", () => {
		const cache = createClientCache<{ i: number }>();
		cache.getOrCreate({ k: 1 }, () => ({ i: 1 }));
		expect(cache.size).toBe(1);
		cache.clear();
		expect(cache.size).toBe(0);
	});
});
