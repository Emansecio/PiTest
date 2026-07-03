/**
 * M21 — context-window-proportional byte caps.
 *
 * `configureTruncationCaps({ contextWindow })` (called once from AgentSession's
 * constructor with the boot-time model) scales the three shared byte budgets:
 * floors at ≤200k-token windows (byte-identical to the historical constants),
 * linear growth up to 2× at a 1M-token window, clamped there. The exports are
 * mutable live bindings, so importers observe the reconfigured values without
 * any call-site changes — which is exactly what these tests assert.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as truncate from "../src/core/tools/truncate.ts";
import { configureTruncationCaps, truncationCapScale } from "../src/core/tools/truncate.ts";

const DEFAULT_FLOOR = 50 * 1024;
const HARD_CAP_FLOOR = 64 * 1024;
const BASH_FLOOR = 24 * 1024;

afterEach(() => {
	// contextWindow <= 0 resets to the floors (documented contract).
	configureTruncationCaps({ contextWindow: 0 });
});

describe("truncationCapScale", () => {
	it("keeps scale 1 for windows at or under 200k (historical behavior)", () => {
		expect(truncationCapScale(0)).toBe(1);
		expect(truncationCapScale(64_000)).toBe(1);
		expect(truncationCapScale(200_000)).toBe(1);
	});

	it("scales linearly between 200k and 1M and clamps at 2×", () => {
		expect(truncationCapScale(600_000)).toBeCloseTo(1.5, 10);
		expect(truncationCapScale(1_000_000)).toBe(2);
		expect(truncationCapScale(2_000_000)).toBe(2); // clamped, never beyond 2×
	});

	it("treats non-finite windows as the floor (unknown window → conservative)", () => {
		expect(truncationCapScale(Number.NaN)).toBe(1);
		expect(truncationCapScale(Number.POSITIVE_INFINITY)).toBe(1);
	});
});

describe("configureTruncationCaps", () => {
	it("leaves the floors untouched for a 200k window", () => {
		configureTruncationCaps({ contextWindow: 200_000 });
		expect(truncate.DEFAULT_MAX_BYTES).toBe(DEFAULT_FLOOR);
		expect(truncate.TOOL_OUTPUT_HARD_CAP_BYTES).toBe(HARD_CAP_FLOOR);
		expect(truncate.BASH_MAX_BYTES).toBe(BASH_FLOOR);
	});

	it("doubles every byte cap at a 1M window", () => {
		configureTruncationCaps({ contextWindow: 1_000_000 });
		expect(truncate.DEFAULT_MAX_BYTES).toBe(DEFAULT_FLOOR * 2);
		expect(truncate.TOOL_OUTPUT_HARD_CAP_BYTES).toBe(HARD_CAP_FLOOR * 2);
		expect(truncate.BASH_MAX_BYTES).toBe(BASH_FLOOR * 2);
	});

	it("is deterministic from the floors — repeated calls never compound", () => {
		configureTruncationCaps({ contextWindow: 1_000_000 });
		configureTruncationCaps({ contextWindow: 1_000_000 });
		expect(truncate.DEFAULT_MAX_BYTES).toBe(DEFAULT_FLOOR * 2);
		configureTruncationCaps({ contextWindow: 200_000 });
		expect(truncate.DEFAULT_MAX_BYTES).toBe(DEFAULT_FLOOR); // scales back down too
	});

	it("preserves the cap ordering invariants at every window size", () => {
		for (const window of [0, 200_000, 400_000, 600_000, 1_000_000, 5_000_000]) {
			configureTruncationCaps({ contextWindow: window });
			// The generic wrapper net must stay above the per-tool default cap so
			// tools that already truncated are never re-cut…
			expect(truncate.TOOL_OUTPUT_HARD_CAP_BYTES).toBeGreaterThan(truncate.DEFAULT_MAX_BYTES);
			// …and bash keeps its deliberately tighter budget.
			expect(truncate.BASH_MAX_BYTES).toBeLessThan(truncate.DEFAULT_MAX_BYTES);
			// Fixed dedicated ceilings stay above even the doubled net.
			expect(truncate.RECALL_OUTPUT_CAP_BYTES).toBeGreaterThan(truncate.TOOL_OUTPUT_HARD_CAP_BYTES);
		}
	});

	it("propagates to truncateHead/truncateTail default byte budgets (live binding)", () => {
		const content = "y".repeat(DEFAULT_FLOOR + 4096); // over the floor, one line
		const atFloor = truncate.truncateHead(content, { maxLines: Number.POSITIVE_INFINITY });
		// A single line larger than the byte budget is reported as over-limit.
		expect(atFloor.truncated).toBe(true);

		configureTruncationCaps({ contextWindow: 1_000_000 });
		const scaled = truncate.truncateHead(content, { maxLines: Number.POSITIVE_INFINITY });
		// The same content fits inside the doubled default budget.
		expect(scaled.truncated).toBe(false);
	});
});
