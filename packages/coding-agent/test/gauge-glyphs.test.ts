import { afterEach, describe, expect, it } from "vitest";
import { GAUGE_EMPTY, GAUGE_FILLED, resolveGaugeGlyphs } from "../src/modes/interactive/components/gauge-glyphs.js";

describe("resolveGaugeGlyphs (A03)", () => {
	afterEach(() => {
		delete process.env.PIT_ASCII_GAUGE;
		if (process.env.TERM === "dumb") delete process.env.TERM;
	});

	it("defaults to parallelogram glyphs", () => {
		delete process.env.PIT_ASCII_GAUGE;
		const g = resolveGaugeGlyphs();
		expect(g.filled).toBe(GAUGE_FILLED);
		expect(g.empty).toBe(GAUGE_EMPTY);
	});

	it("uses ●/○ when PIT_ASCII_GAUGE=1", () => {
		process.env.PIT_ASCII_GAUGE = "1";
		const g = resolveGaugeGlyphs();
		expect(g.filled).toBe("●");
		expect(g.empty).toBe("○");
	});
});
