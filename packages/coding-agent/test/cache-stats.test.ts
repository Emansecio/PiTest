import type { Usage } from "@pit/ai";
import { describe, expect, test } from "vitest";
import { computeCacheStats } from "../src/core/cache-stats.js";

function mkUsage(input: number, cacheRead: number, cacheWrite: number): Usage {
	return {
		input,
		output: 0,
		cacheRead,
		cacheWrite,
		totalTokens: input + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** assistant turn with the given cache breakdown */
function asg(input: number, cacheRead: number, cacheWrite: number) {
	return { role: "assistant", usage: mkUsage(input, cacheRead, cacheWrite) };
}
const usr = { role: "user" };

describe("computeCacheStats", () => {
	test("aggregates totals, per-turn breakdown, and hit-rate", () => {
		const stats = computeCacheStats([usr, asg(100, 0, 100), usr, asg(10, 180, 10)]);

		expect(stats.turns).toHaveLength(2);
		expect(stats.turns[0]).toMatchObject({ index: 1, input: 100, cacheRead: 0, cacheWrite: 100, hitRate: 0 });
		expect(stats.turns[1].index).toBe(2);
		expect(stats.turns[1].hitRate).toBeCloseTo(0.9, 5); // 180 / 200

		expect(stats.totalInput).toBe(110);
		expect(stats.totalCacheRead).toBe(180);
		expect(stats.totalCacheWrite).toBe(110);
		expect(stats.promptTokens).toBe(400);
		expect(stats.hitRate).toBeCloseTo(0.45, 5); // 180 / 400
		expect(stats.estReadSavingsTokens).toBe(162); // round(180 * 0.9)
		expect(stats.cacheObserved).toBe(true);
	});

	test("ignores non-assistant and usage-less messages", () => {
		const stats = computeCacheStats([usr, { role: "toolResult" }, { role: "assistant" }, asg(50, 50, 0)]);
		expect(stats.turns).toHaveLength(1);
		expect(stats.turns[0].input).toBe(50);
	});

	test("cacheObserved is false and hit-rate 0 when no caching happens", () => {
		const stats = computeCacheStats([asg(100, 0, 0), asg(50, 0, 0)]);
		expect(stats.cacheObserved).toBe(false);
		expect(stats.hitRate).toBe(0);
		expect(stats.instabilityTurn).toBeNull();
	});

	test("flags a hit-rate collapse after the cache has warmed", () => {
		// t1 cold (0%), t2/t3 warm (~80/85%), t4 collapses (10%)
		const stats = computeCacheStats([asg(100, 0, 100), asg(10, 80, 10), asg(5, 85, 10), asg(90, 10, 0)]);
		expect(stats.instabilityTurn).toBe(4);
	});

	test("no instability flag when hit-rate ramps and holds", () => {
		const stats = computeCacheStats([asg(100, 0, 100), asg(10, 80, 10), asg(5, 90, 5)]);
		expect(stats.instabilityTurn).toBeNull();
	});

	test("cold first turn alone never trips the instability heuristic", () => {
		const stats = computeCacheStats([asg(100, 0, 100)]);
		expect(stats.instabilityTurn).toBeNull();
		expect(stats.turns[0].hitRate).toBe(0);
	});

	test("empty transcript yields zeroed stats", () => {
		const stats = computeCacheStats([]);
		expect(stats.turns).toHaveLength(0);
		expect(stats.hitRate).toBe(0);
		expect(stats.cacheObserved).toBe(false);
	});
});
