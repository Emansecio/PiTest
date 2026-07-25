import { describe, expect, it } from "vitest";
import { calculateCost, LONG_CACHE_WRITE_MULTIPLIER } from "../src/models.ts";
import type { Model, Usage } from "../src/types.ts";

/**
 * The model catalog carries the SHORT-tier cache-write price (Anthropic 1.25x
 * base input). `cacheWriteLong` is the slice the provider reported as written at
 * the 1h tier, which is billed 1.6x higher. Anything that doesn't report the
 * split must price exactly as it did before the split existed.
 */

// claude-opus-5's real numbers: input 5 => 5m write 6.25 (1.25x), 1h write 10 (2.0x).
const MODEL = {
	cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
} as unknown as Model<any>;

function usageWith(cacheWrite: number, cacheWriteLong?: number): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite,
		...(cacheWriteLong === undefined ? {} : { cacheWriteLong }),
		totalTokens: cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

describe("calculateCost — retention-aware cache writes", () => {
	it("prices an all-long write at 2.0x base input, not 1.25x", () => {
		const usage = usageWith(1_000_000, 1_000_000);
		calculateCost(MODEL, usage);
		// 1.6 x 6.25 = 10.00 == 2.0 x the model's 5.00 input price.
		expect(usage.cost.cacheWrite).toBeCloseTo(10, 10);
		expect(usage.cost.cacheWrite).toBeCloseTo(MODEL.cost.input * 2, 10);
	});

	it("leaves a short-only write at the listed rate", () => {
		const usage = usageWith(1_000_000, 0);
		calculateCost(MODEL, usage);
		expect(usage.cost.cacheWrite).toBeCloseTo(6.25, 10);
	});

	it("is byte-identical to the pre-split behavior when the provider omits the breakdown", () => {
		const usage = usageWith(1_000_000);
		calculateCost(MODEL, usage);
		expect(usage.cost.cacheWrite).toBeCloseTo(6.25, 10);
	});

	it("bills a mixed request per slice", () => {
		const usage = usageWith(1_000_000, 400_000);
		calculateCost(MODEL, usage);
		// 600k short @6.25/M + 400k long @10/M
		expect(usage.cost.cacheWrite).toBeCloseTo(0.6 * 6.25 + 0.4 * 10, 10);
	});

	it("clamps a long slice larger than the total instead of inflating the bill", () => {
		const usage = usageWith(1_000_000, 5_000_000);
		calculateCost(MODEL, usage);
		expect(usage.cost.cacheWrite).toBeCloseTo(10, 10);
	});

	it("clamps a negative long slice", () => {
		const usage = usageWith(1_000_000, -50);
		calculateCost(MODEL, usage);
		expect(usage.cost.cacheWrite).toBeCloseTo(6.25, 10);
	});

	it("folds the cache-write cost into the total", () => {
		const usage = usageWith(1_000_000, 1_000_000);
		usage.input = 1_000_000;
		calculateCost(MODEL, usage);
		expect(usage.cost.total).toBeCloseTo(5 + 10, 10);
	});

	it("keeps the multiplier pinned to Anthropic's 2.0x / 1.25x ratio", () => {
		expect(LONG_CACHE_WRITE_MULTIPLIER).toBeCloseTo(2.0 / 1.25, 10);
	});
});
