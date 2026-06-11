import { beforeAll, describe, expect, it } from "vitest";
import {
	CONTEXT_USAGE_CRITICAL_PERCENT,
	CONTEXT_USAGE_ERROR_PERCENT,
	CONTEXT_USAGE_WARN_PERCENT,
	initTheme,
	theme,
} from "../src/modes/interactive/theme/theme.js";

describe("theme.getContextUsageColor", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});

	// A colorizer is identified by the palette color it wraps text in.
	const sample = (fn: (s: string) => string): string => fn("_");
	const expected = (color: "accent" | "warning" | "error"): string => theme.fg(color, "_");
	const expectedCritical = (): string => `\x1b[1m${theme.fg("error", "_")}\x1b[22m`;

	it("uses the calm accent below the warn threshold", () => {
		expect(sample(theme.getContextUsageColor(0))).toBe(expected("accent"));
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_WARN_PERCENT - 0.1))).toBe(expected("accent"));
	});

	it("uses warning above the warn threshold and up to the error threshold", () => {
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_WARN_PERCENT + 0.1))).toBe(expected("warning"));
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_ERROR_PERCENT))).toBe(expected("warning"));
	});

	it("uses error above the error threshold and up to the critical threshold", () => {
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_ERROR_PERCENT + 0.1))).toBe(expected("error"));
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_CRITICAL_PERCENT))).toBe(expected("error"));
	});

	it("uses bold error above the critical threshold", () => {
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_CRITICAL_PERCENT + 0.1))).toBe(expectedCritical());
		expect(sample(theme.getContextUsageColor(100))).toBe(expectedCritical());
		// Critical is visibly distinct from plain error.
		expect(sample(theme.getContextUsageColor(100))).not.toBe(expected("error"));
	});

	it("treats all thresholds as strict (lower band owns the boundary)", () => {
		// Exactly at the threshold → still the lower band.
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_WARN_PERCENT))).toBe(expected("accent"));
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_ERROR_PERCENT))).toBe(expected("warning"));
		expect(sample(theme.getContextUsageColor(CONTEXT_USAGE_CRITICAL_PERCENT))).toBe(expected("error"));
	});
});
