import { describe, expect, it } from "vitest";
import { parseCompactSoftRatio, shouldStartBackgroundCompaction } from "../src/core/agent-session-compaction.ts";
import {
	type CompactionSettings,
	computeDynamicReserve,
	effectiveKeepRecentTokens,
	shouldCompactSoft,
} from "../src/core/compaction/index.ts";

const CONTEXT_WINDOW = 200_000;
const settings: CompactionSettings = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
};

function thresholds(cw: number, s: CompactionSettings) {
	const reserve = computeDynamicReserve(cw, s.reserveTokens);
	const hard = cw - reserve;
	const keep = effectiveKeepRecentTokens(s.keepRecentTokens, cw);
	return { hard, keep };
}

describe("parseCompactSoftRatio", () => {
	it("defaults to 1.5 when unset/empty/non-numeric", () => {
		expect(parseCompactSoftRatio(undefined)).toBe(1.5);
		expect(parseCompactSoftRatio("")).toBe(1.5);
		expect(parseCompactSoftRatio("abc")).toBe(1.5);
	});

	it("clamps into [1.0, 4.0]", () => {
		expect(parseCompactSoftRatio("0.2")).toBe(1);
		expect(parseCompactSoftRatio("9")).toBe(4);
		expect(parseCompactSoftRatio("2")).toBe(2);
	});
});

describe("shouldStartBackgroundCompaction", () => {
	const { hard, keep } = thresholds(CONTEXT_WINDOW, settings);

	it("is a superset of shouldCompactSoft — fires everywhere the legacy soft band does", () => {
		for (let ctx = hard - keep - 5_000; ctx < hard; ctx += 1_000) {
			if (shouldCompactSoft(ctx, CONTEXT_WINDOW, settings)) {
				expect(shouldStartBackgroundCompaction(ctx, CONTEXT_WINDOW, settings, 1.5)).toBe(true);
			}
		}
	});

	it("fires EARLIER than the legacy soft band (wider predictive window)", () => {
		// A point inside the widened band (1.5x) but above the legacy soft threshold.
		const legacySoft = hard - keep;
		const widenedSoft = hard - keep * 1.5;
		const between = Math.floor((legacySoft + widenedSoft) / 2);
		expect(shouldCompactSoft(between, CONTEXT_WINDOW, settings)).toBe(false);
		expect(shouldStartBackgroundCompaction(between, CONTEXT_WINDOW, settings, 1.5)).toBe(true);
	});

	it("is identical to shouldCompactSoft at ratio 1.0", () => {
		for (let ctx = hard - keep - 5_000; ctx < hard + 5_000; ctx += 1_000) {
			expect(shouldStartBackgroundCompaction(ctx, CONTEXT_WINDOW, settings, 1.0)).toBe(
				shouldCompactSoft(ctx, CONTEXT_WINDOW, settings),
			);
		}
	});

	it("yields to the synchronous hard path once strictly over the hard threshold", () => {
		// At exactly `hard` the sync `shouldCompact` does not fire (contextTokens <= threshold),
		// so the predictive path still owns the boundary — matching `shouldCompactSoft`.
		expect(shouldStartBackgroundCompaction(hard, CONTEXT_WINDOW, settings)).toBe(
			shouldCompactSoft(hard, CONTEXT_WINDOW, settings),
		);
		// Strictly over the hard wall the synchronous path owns it.
		expect(shouldStartBackgroundCompaction(hard + 1, CONTEXT_WINDOW, settings)).toBe(false);
		expect(shouldStartBackgroundCompaction(hard + 50_000, CONTEXT_WINDOW, settings)).toBe(false);
	});

	it("does not fire well below the widened band", () => {
		const widenedSoft = hard - keep * 1.5;
		expect(shouldStartBackgroundCompaction(widenedSoft - 10_000, CONTEXT_WINDOW, settings)).toBe(false);
	});

	it("returns false when disabled or the window is invalid", () => {
		expect(shouldStartBackgroundCompaction(hard - 1, CONTEXT_WINDOW, { ...settings, enabled: false })).toBe(false);
		expect(shouldStartBackgroundCompaction(1_000, 0, settings)).toBe(false);
	});
});
