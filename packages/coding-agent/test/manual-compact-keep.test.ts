import { describe, expect, it } from "vitest";
import {
	effectiveKeepRecentTokens,
	MANUAL_COMPACT_KEEP_FRACTION,
	manualKeepRecentTokens,
} from "../src/core/compaction/index.ts";

const CONFIGURED = 20_000;
/** Mirrors the module-private ADAPTIVE_KEEP_MIN_FLOOR — asserted, not imported,
 * so the constant does not need a test-only export to widen its visibility. */
const ADAPTIVE_KEEP_MIN_FLOOR = 8_000;
const WINDOW_1M = 1_000_000;
const WINDOW_200K = 200_000;

describe("manualKeepRecentTokens", () => {
	it("falls back to the window-scaled budget when the live size is unknown", () => {
		expect(manualKeepRecentTokens(CONFIGURED, WINDOW_1M, undefined)).toBe(
			effectiveKeepRecentTokens(CONFIGURED, WINDOW_1M),
		);
		expect(manualKeepRecentTokens(CONFIGURED, WINDOW_1M, 0)).toBe(effectiveKeepRecentTokens(CONFIGURED, WINDOW_1M));
	});

	it("scales with live usage instead of the window", () => {
		expect(manualKeepRecentTokens(CONFIGURED, WINDOW_1M, 200_000)).toBe(50_000);
		expect(manualKeepRecentTokens(CONFIGURED, WINDOW_1M, 400_000)).toBe(100_000);
	});

	it("never exceeds the window-scaled budget — manual is never gentler than auto", () => {
		// 2M live on a 1M window: 25% would be 500k, but auto would keep 100k.
		const windowScaled = effectiveKeepRecentTokens(CONFIGURED, WINDOW_1M);
		expect(manualKeepRecentTokens(CONFIGURED, WINDOW_1M, 2_000_000)).toBe(windowScaled);
	});

	it("never drops below the adaptive floor", () => {
		// 25% of 10k is 2.5k — under the floor that guarantees some verbatim tail.
		expect(manualKeepRecentTokens(CONFIGURED, WINDOW_1M, 10_000)).toBe(ADAPTIVE_KEEP_MIN_FLOOR);
	});

	it("is a no-op on windows at or below 200k, where the window scaling never applied", () => {
		// effectiveKeepRecentTokens returns the configured value there; 25% of a
		// large live context is still capped by it.
		expect(manualKeepRecentTokens(CONFIGURED, WINDOW_200K, 190_000)).toBe(CONFIGURED);
	});

	it("the fraction is the documented 25%", () => {
		expect(MANUAL_COMPACT_KEEP_FRACTION).toBe(0.25);
	});

	// The regression this exists for: a FLAT window-scaled floor reclaims almost
	// nothing once the session is near it, while a usage-scaled budget holds a
	// constant fold ratio at every size. Sizes mirror the measured probe.
	it.each([
		[111_000, 8],
		[194_000, 48],
		[277_000, 63],
	])("live %i tokens: window-scaled keeps ~100k (folds ~%i%%), usage-scaled keeps 25%%", (live) => {
		expect(effectiveKeepRecentTokens(CONFIGURED, WINDOW_1M)).toBe(100_000);
		const manual = manualKeepRecentTokens(CONFIGURED, WINDOW_1M, live);
		expect(manual).toBe(Math.floor(live * 0.25));
		// Fold share is constant regardless of session size.
		expect(Math.round(((live - manual) / live) * 100)).toBe(75);
	});
});
