import { describe, expect, it } from "vitest";
import { LruMap } from "../src/core/lru-map.js";

describe("LruMap", () => {
	it("evicts the least-recent entry past the cap", () => {
		const cache = new LruMap<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		expect(cache.has("a")).toBe(true);
		expect(cache.has("b")).toBe(false);
		expect(cache.has("c")).toBe(true);
	});

	it("refreshes recency on get so a re-hit survives eviction", () => {
		const cache = new LruMap<string, number>(2);
		cache.set("a", 1);
		cache.set("b", 2);
		cache.get("a");
		cache.set("c", 3);
		expect(cache.get("a")).toBe(1);
		expect(cache.has("b")).toBe(false);
	});
});
