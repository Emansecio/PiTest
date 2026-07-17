/**
 * Unit tests for the pure tail-cycle detector (doom-loop-cycle.ts).
 *
 * detectTailCycle mirrors forgecode's count_recent_pattern_repetitions: for each
 * candidate period it walks BACKWARDS from the tail and counts how many
 * consecutive copies of the final block repeat. Anchoring at the tail is the whole
 * point — earlier, different history (exploration/setup) must never prevent
 * detection of a loop that started later.
 */

import { describe, expect, it } from "vitest";
import { canonicalCycleKey, detectTailCycle } from "../src/core/doom-loop-cycle.ts";

describe("detectTailCycle", () => {
	it("detects a period-1 identical loop (default minRepetitions 3)", () => {
		expect(detectTailCycle(["a", "a", "a"])).toEqual({ period: 1, repetitions: 3 });
		expect(detectTailCycle(["a", "a", "a", "a", "a"])).toEqual({ period: 1, repetitions: 5 });
	});

	it("detects a period-2 cycle repeated at the tail", () => {
		expect(detectTailCycle(["a", "b", "a", "b", "a", "b"])).toEqual({ period: 2, repetitions: 3 });
	});

	it("detects a period-3 cycle [a,b,c] repeated 3 times", () => {
		expect(detectTailCycle(["a", "b", "c", "a", "b", "c", "a", "b", "c"])).toEqual({ period: 3, repetitions: 3 });
	});

	it("is TAIL-anchored: earlier different history never blocks detection", () => {
		// Four unrelated calls, THEN a [a,b] loop of 3 reps. The noise prefix must be
		// ignored — only the trailing run counts.
		expect(detectTailCycle(["x", "y", "z", "q", "a", "b", "a", "b", "a", "b"])).toEqual({
			period: 2,
			repetitions: 3,
		});
	});

	it("counts only the UNBROKEN trailing run (a break resets the count)", () => {
		// [a,b] repeats, but a stray 'q' breaks the run one cycle back, so only the
		// final two [a,b] blocks survive — below the default threshold of 3.
		expect(detectTailCycle(["a", "b", "q", "a", "b", "a", "b"])).toBeNull();
	});

	it("does NOT trigger on read-style exploration (distinct signatures, no repeat)", () => {
		// read(f1), read(f2), read(f3): three DISTINCT per-call signatures form no
		// repeating block, so nothing fires — the canonical false positive to avoid.
		expect(detectTailCycle(["read:f1", "read:f2", "read:f3"])).toBeNull();
		expect(detectTailCycle(["read:f1", "read:f2", "read:f3", "read:f4", "read:f5"])).toBeNull();
	});

	it("returns null when repetitions stay below minRepetitions", () => {
		// [a,b] twice = 2 reps; the default threshold is 3.
		expect(detectTailCycle(["a", "b", "a", "b"])).toBeNull();
		// Same block at 3 reps DOES fire.
		expect(detectTailCycle(["a", "b", "a", "b", "a", "b"])).toEqual({ period: 2, repetitions: 3 });
	});

	it("honours a lower minRepetitions", () => {
		expect(detectTailCycle(["a", "b", "a", "b"], { minRepetitions: 2 })).toEqual({ period: 2, repetitions: 2 });
	});

	it("excludes period-1 identical loops when minPeriod is 2", () => {
		expect(detectTailCycle(["a", "a", "a", "a"], { minPeriod: 2, minRepetitions: 2 })).toEqual({
			period: 2,
			repetitions: 2,
		});
		// With requireDistinctBlock the all-identical block is rejected outright.
		expect(
			detectTailCycle(["a", "a", "a", "a"], { minPeriod: 2, minRepetitions: 2, requireDistinctBlock: true }),
		).toBeNull();
	});

	it("bounds the scan to the last maxEntries entries", () => {
		// Full sequence is [a,b]x4 (4 reps); a window of 6 only sees the last 3 reps.
		expect(detectTailCycle(["a", "b", "a", "b", "a", "b", "a", "b"], { maxEntries: 6, minRepetitions: 2 })).toEqual({
			period: 2,
			repetitions: 3,
		});
	});

	it("prefers the longer cycle on a repetition tie", () => {
		// [a,b,c] twice: a period-2 read of the tail would not align, so the period-3
		// cycle wins. With minRepetitions 2 both could qualify only if they tie.
		expect(detectTailCycle(["a", "b", "c", "a", "b", "c"], { minRepetitions: 2 })).toEqual({
			period: 3,
			repetitions: 2,
		});
	});

	it("returns null on short or empty input", () => {
		expect(detectTailCycle([])).toBeNull();
		expect(detectTailCycle(["a"])).toBeNull();
		expect(detectTailCycle(["a", "b"])).toBeNull();
	});
});

describe("canonicalCycleKey", () => {
	it("is invariant across rotations of the same cycle", () => {
		const k1 = canonicalCycleKey(["read", "edit", "bash"]);
		const k2 = canonicalCycleKey(["edit", "bash", "read"]);
		const k3 = canonicalCycleKey(["bash", "read", "edit"]);
		expect(k2).toBe(k1);
		expect(k3).toBe(k1);
	});

	it("distinguishes cycles with a different order (not just a rotation)", () => {
		expect(canonicalCycleKey(["a", "b", "c"])).not.toBe(canonicalCycleKey(["a", "c", "b"]));
	});

	it("handles empty and single-element inputs", () => {
		expect(canonicalCycleKey([])).toBe("");
		expect(canonicalCycleKey(["only"])).toBe("only");
	});
});
