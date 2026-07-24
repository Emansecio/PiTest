import { describe, expect, it } from "vitest";
import {
	evaluatePruneCacheEconomics,
	PRUNE_CACHE_ECONOMICS_HORIZON_TURNS,
	type PruneCacheEconomicsInput,
} from "../src/core/prune-economics.js";

// Anthropic-Sonnet-like cache pricing: read 0.3, write 3.75 → premium 3.45 $/1M.
const SONNET = { cacheReadCostPerMTok: 0.3, cacheWriteCostPerMTok: 3.75 };

function input(overrides: Partial<PruneCacheEconomicsInput>): PruneCacheEconomicsInput {
	return {
		reclaimedTokens: 1_000,
		tailTokens: 100_000,
		occupancy: 0.1,
		pressureRatio: 0.92,
		...SONNET,
		...overrides,
	};
}

describe("evaluatePruneCacheEconomics", () => {
	it("defers when a small reclaim can't earn back a large tail invalidation", () => {
		// reclaimed 1k, tail 100k: recurring = 1000*0.3*10/1e6 = 0.003;
		// oneTime = (100000-1000)*3.45/1e6 = 0.34155 → 0.003 < 0.34 → defer.
		const d = evaluatePruneCacheEconomics(input({ reclaimedTokens: 1_000, tailTokens: 100_000 }));
		expect(d.defer).toBe(true);
		expect(d.reason).toBe("defer-below-horizon");
		expect(d.recurringReadSavingsUsd).toBeCloseTo(0.003, 6);
		expect(d.oneTimeInvalidationCostUsd).toBeCloseTo(0.34155, 5);
	});

	it("prunes when the reclaim is large relative to the tail (gain covers the re-write)", () => {
		// reclaimed 50k, tail 51k: recurring = 50000*0.3*10/1e6 = 0.15;
		// oneTime = (51000-50000)*3.45/1e6 = 0.00345 → gain >> cost → prune.
		const d = evaluatePruneCacheEconomics(input({ reclaimedTokens: 50_000, tailTokens: 51_000 }));
		expect(d.defer).toBe(false);
		expect(d.reason).toBe("gain-covers-cost");
	});

	it("treats the exact break-even point as prune (>=), and one token past it as defer", () => {
		// Clean-number costs: read 1, write 2 → premium 1, horizon 10.
		// recurring = R*1*10 = 10R ; oneTime = (T-R)*1 = T-R. Equal when T = 11R.
		const costs = { cacheReadCostPerMTok: 1, cacheWriteCostPerMTok: 2 };
		const atBreakEven = evaluatePruneCacheEconomics(input({ reclaimedTokens: 1_000, tailTokens: 11_000, ...costs }));
		expect(atBreakEven.defer).toBe(false); // recurring == oneTime → gain covers
		expect(atBreakEven.reason).toBe("gain-covers-cost");
		expect(atBreakEven.recurringReadSavingsUsd).toBeCloseTo(atBreakEven.oneTimeInvalidationCostUsd, 9);

		const justPast = evaluatePruneCacheEconomics(input({ reclaimedTokens: 1_000, tailTokens: 11_001, ...costs }));
		expect(justPast.defer).toBe(true);
		expect(justPast.reason).toBe("defer-below-horizon");
	});

	it("never defers in the pressure band (occupancy >= pressureRatio), regardless of the math", () => {
		// Same numbers as the defer case, but pushed into the pressure band.
		const d = evaluatePruneCacheEconomics(
			input({ reclaimedTokens: 1_000, tailTokens: 100_000, occupancy: 0.95, pressureRatio: 0.92 }),
		);
		expect(d.defer).toBe(false);
		expect(d.reason).toBe("pressure-band");
	});

	it("treats occupancy exactly at the ratio as pressure band (>=)", () => {
		const d = evaluatePruneCacheEconomics(
			input({ reclaimedTokens: 1_000, tailTokens: 100_000, occupancy: 0.92, pressureRatio: 0.92 }),
		);
		expect(d.defer).toBe(false);
		expect(d.reason).toBe("pressure-band");
	});

	it("never defers when the provider has no cache-write price (write = 0)", () => {
		// Codex-like: cacheWrite 0 → no re-write penalty to weigh.
		const d = evaluatePruneCacheEconomics(
			input({ reclaimedTokens: 1_000, tailTokens: 100_000, cacheReadCostPerMTok: 0.075, cacheWriteCostPerMTok: 0 }),
		);
		expect(d.defer).toBe(false);
		expect(d.reason).toBe("no-cache-pricing");
		expect(d.oneTimeInvalidationCostUsd).toBe(0);
	});

	it("never defers when cacheRead is zero/absent", () => {
		const d = evaluatePruneCacheEconomics(input({ cacheReadCostPerMTok: 0, cacheWriteCostPerMTok: 3.75 }));
		expect(d.defer).toBe(false);
		expect(d.reason).toBe("no-cache-pricing");
	});

	it("never defers when the write premium is non-positive (write <= read)", () => {
		const d = evaluatePruneCacheEconomics(input({ cacheReadCostPerMTok: 2, cacheWriteCostPerMTok: 1 }));
		expect(d.defer).toBe(false);
		expect(d.reason).toBe("no-cache-pricing");
	});

	it("never defers when nothing was reclaimed", () => {
		const d = evaluatePruneCacheEconomics(input({ reclaimedTokens: 0, tailTokens: 100_000 }));
		expect(d.defer).toBe(false);
		expect(d.reason).toBe("nothing-reclaimed");
	});

	it("clamps a tail smaller than the reclaim to a zero re-write cost (never defers)", () => {
		// Degenerate input (tail < reclaimed): rewrittenTokens clamps to 0 → oneTime 0
		// → recurring >= 0 → gain covers, prune.
		const d = evaluatePruneCacheEconomics(input({ reclaimedTokens: 5_000, tailTokens: 1_000 }));
		expect(d.defer).toBe(false);
		expect(d.oneTimeInvalidationCostUsd).toBe(0);
		expect(d.reason).toBe("gain-covers-cost");
	});

	it("honors a custom horizon (longer horizon → more likely to prune)", () => {
		const base = input({
			reclaimedTokens: 1_000,
			tailTokens: 11_001,
			cacheReadCostPerMTok: 1,
			cacheWriteCostPerMTok: 2,
		});
		expect(evaluatePruneCacheEconomics(base).defer).toBe(true); // horizon 10 → defer
		// A long horizon lifts recurring savings above the one-time cost → prune.
		expect(evaluatePruneCacheEconomics({ ...base, horizonTurns: 1_000 }).defer).toBe(false);
	});

	it("exposes the default horizon constant", () => {
		expect(PRUNE_CACHE_ECONOMICS_HORIZON_TURNS).toBe(10);
	});
});
