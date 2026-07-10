import { afterEach, describe, expect, test } from "vitest";
import { parsePresendOverflowRatio, resolveDynamicPresendOverflowRatio } from "../src/core/agent-session-compaction.js";

// A2: PIT_PRESEND_OVERFLOW_RATIO override — numeric values clamp into
// [0.5, 0.99]; non-numeric / empty fall back to the 0.95 default.
describe("parsePresendOverflowRatio (A2)", () => {
	test("undefined / empty fall back to the 0.95 default", () => {
		expect(parsePresendOverflowRatio(undefined)).toBe(0.95);
		expect(parsePresendOverflowRatio("")).toBe(0.95);
	});

	test("non-numeric falls back to the default", () => {
		expect(parsePresendOverflowRatio("abc")).toBe(0.95);
		expect(parsePresendOverflowRatio("NaN")).toBe(0.95);
	});

	test("accepts an in-range value verbatim", () => {
		expect(parsePresendOverflowRatio("0.9")).toBe(0.9);
		expect(parsePresendOverflowRatio("0.5")).toBe(0.5);
		expect(parsePresendOverflowRatio("0.99")).toBe(0.99);
	});

	test("clamps out-of-range values into [0.5, 0.99]", () => {
		expect(parsePresendOverflowRatio("0.1")).toBe(0.5);
		expect(parsePresendOverflowRatio("1.5")).toBe(0.99);
		expect(parsePresendOverflowRatio("-3")).toBe(0.5);
	});
});

describe("resolveDynamicPresendOverflowRatio (T10)", () => {
	const w = 100_000;
	const prev = process.env.PIT_NO_DYNAMIC_PRESEND_RATIO;
	afterEach(() => {
		if (prev === undefined) delete process.env.PIT_NO_DYNAMIC_PRESEND_RATIO;
		else process.env.PIT_NO_DYNAMIC_PRESEND_RATIO = prev;
	});

	test("stays at baseRatio under 50% occupancy with low trailing share", () => {
		delete process.env.PIT_NO_DYNAMIC_PRESEND_RATIO;
		const ratio = resolveDynamicPresendOverflowRatio({
			baseRatio: 0.95,
			pressure: 0.4 * w,
			contextWindow: w,
			trailingTokens: 0,
			assembled: 0.4 * w,
		});
		expect(ratio).toBe(0.95);
	});

	test("tightens to floor at high occupancy", () => {
		delete process.env.PIT_NO_DYNAMIC_PRESEND_RATIO;
		const ratio = resolveDynamicPresendOverflowRatio({
			baseRatio: 0.95,
			pressure: 0.93 * w,
			contextWindow: w,
			trailingTokens: 0,
			assembled: 0.93 * w,
		});
		expect(ratio).toBeCloseTo(0.88, 5);
	});

	test("higher trailing share tightens further at mid occupancy", () => {
		delete process.env.PIT_NO_DYNAMIC_PRESEND_RATIO;
		const lowTrail = resolveDynamicPresendOverflowRatio({
			baseRatio: 0.95,
			pressure: 0.7 * w,
			contextWindow: w,
			trailingTokens: 0,
			assembled: 0.7 * w,
		});
		const highTrail = resolveDynamicPresendOverflowRatio({
			baseRatio: 0.95,
			pressure: 0.7 * w,
			contextWindow: w,
			trailingTokens: 0.4 * 0.7 * w,
			assembled: 0.7 * w,
		});
		expect(highTrail).toBeLessThan(lowTrail);
	});

	test("never exceeds baseRatio from env", () => {
		delete process.env.PIT_NO_DYNAMIC_PRESEND_RATIO;
		const ratio = resolveDynamicPresendOverflowRatio({
			baseRatio: 0.85,
			pressure: 0.4 * w,
			contextWindow: w,
			trailingTokens: 0,
			assembled: 0.4 * w,
		});
		expect(ratio).toBe(0.85);
	});

	test("PIT_NO_DYNAMIC_PRESEND_RATIO disables tightening", () => {
		process.env.PIT_NO_DYNAMIC_PRESEND_RATIO = "1";
		const ratio = resolveDynamicPresendOverflowRatio({
			baseRatio: 0.95,
			pressure: 0.93 * w,
			contextWindow: w,
			trailingTokens: 0.5 * w,
			assembled: 0.93 * w,
		});
		expect(ratio).toBe(0.95);
	});
});
