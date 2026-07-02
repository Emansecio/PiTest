import { describe, expect, test } from "vitest";
import { parsePresendOverflowRatio } from "../src/core/agent-session-compaction.js";

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
