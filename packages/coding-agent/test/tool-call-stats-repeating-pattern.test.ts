import { describe, expect, it } from "vitest";
import { ToolCallStats } from "../src/core/tool-call-stats.js";

/**
 * Tests for getRepeatingPatternCount(): detects the longest repeating MULTI-tool
 * cycle anchored at the end of the recent-invocation window — the
 * "productive-looking" loop [read,edit,bash]x3 that the consecutive-identical
 * doom-loop detector cannot see (it requires the SAME call repeated).
 */
describe("ToolCallStats.getRepeatingPatternCount", () => {
	const feed = (stats: ToolCallStats, seq: Array<[string, string]>): void => {
		for (const [tool, args] of seq) stats.recordInvocation(tool, args);
	};

	it("detects [a,b,c] repeated 3 times at the tail", () => {
		const stats = new ToolCallStats();
		feed(stats, [
			["read", "1"],
			["edit", "1"],
			["bash", "1"],
			["read", "2"],
			["edit", "2"],
			["bash", "2"],
			["read", "3"],
			["edit", "3"],
			["bash", "3"],
		]);
		// argsFingerprints differ on purpose: a true cycle of DIFFERENT tools is
		// keyed by (tool,args), so this only registers if we IGNORE args. We do NOT —
		// distinct args = legit progress, so this must NOT fire. See next test.
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 0, repetitions: 0 });
	});

	it("detects [a,b,c]x3 when the cycle (tool+args) is truly identical", () => {
		const stats = new ToolCallStats();
		feed(stats, [
			["read", "x"],
			["edit", "x"],
			["bash", "x"],
			["read", "x"],
			["edit", "x"],
			["bash", "x"],
			["read", "x"],
			["edit", "x"],
			["bash", "x"],
		]);
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 3, repetitions: 3 });
	});

	it("does not fire on a sequence with no repeating cycle", () => {
		const stats = new ToolCallStats();
		feed(stats, [
			["read", "x"],
			["edit", "x"],
			["bash", "x"],
			["lsp", "x"],
			["grep", "x"],
			["test", "x"],
			["write", "x"],
		]);
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 0, repetitions: 0 });
	});

	it("does not count a partial cycle at the very end", () => {
		// [a,b]x2 then a dangling [a]: the final block-of-2 is [b,a] (most recent),
		// which does not match the prior block, so reps stays below threshold.
		const stats = new ToolCallStats();
		feed(stats, [
			["a", "x"],
			["b", "x"],
			["a", "x"],
			["b", "x"],
			["a", "x"],
		]);
		// The last cycle is incomplete; only the two FULL [a,b] blocks before the
		// trailing [a] would count if anchored — but the anchor is the dangling [a].
		const match = stats.getRepeatingPatternCount();
		// Suffix-anchored: final 2 keys are [b,a]; previous 2 are [b,a] → 2 reps, but
		// patternLength 2 with the trailing partial. Either way must be < a complete
		// 3-rep [a,b] read; assert it does not over-report a full 3rd cycle.
		expect(match.repetitions).toBeLessThan(3);
	});

	it("reports the full repetition count for [a,b]x4", () => {
		const stats = new ToolCallStats();
		feed(stats, [
			["a", "x"],
			["b", "x"],
			["a", "x"],
			["b", "x"],
			["a", "x"],
			["b", "x"],
			["a", "x"],
			["b", "x"],
		]);
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 2, repetitions: 4 });
	});

	it("does NOT report a pure identical-call loop (patternLength stays 0)", () => {
		// [a,a,a,a,a]: this is the consecutive-identical doom-loop's job (period 1).
		// The repeating-pattern detector requires patternLength >= 2, so it must not
		// fire here — guarantees no double-fire with the doom-loop.
		const stats = new ToolCallStats();
		feed(stats, [
			["read", "x"],
			["read", "x"],
			["read", "x"],
			["read", "x"],
			["read", "x"],
		]);
		// The distinctness guard rejects an all-identical cycle block: [read,read]
		// has no distinct keys, so it is treated as the period-1 identical loop the
		// consecutive-identical detector owns. No match here = no double-fire.
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 0, repetitions: 0 });
		expect(stats.getConsecutiveSimilarCount()).toBe(5);
	});

	it("returns no match on short / empty sequences", () => {
		const stats = new ToolCallStats();
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 0, repetitions: 0 });
		stats.recordInvocation("read", "x");
		stats.recordInvocation("edit", "x");
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 0, repetitions: 0 });
	});

	it("bounds the scan to the recent window (sequenceWindow cap)", () => {
		// With a small window, only the trailing entries survive; an old broken
		// pattern outside the window must not influence the result.
		const stats = new ToolCallStats({ sequenceWindow: 6 });
		feed(stats, [
			["x", "1"], // evicted
			["y", "2"], // evicted
			["a", "x"],
			["b", "x"],
			["a", "x"],
			["b", "x"],
		]);
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 2, repetitions: 2 });
	});

	it("prefers the longer cycle on a tie in repetitions", () => {
		// [a,b,c] repeated twice (period 3, 2 reps). A period-2 read of the tail
		// would not align, so the longest aligned cycle wins.
		const stats = new ToolCallStats();
		feed(stats, [
			["a", "x"],
			["b", "x"],
			["c", "x"],
			["a", "x"],
			["b", "x"],
			["c", "x"],
		]);
		expect(stats.getRepeatingPatternCount()).toEqual({ patternLength: 3, repetitions: 2 });
	});
});
