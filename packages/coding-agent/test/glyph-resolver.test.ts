import { SPINNER_FRAMES } from "@pit/tui";
import { afterEach, describe, expect, it } from "vitest";
import {
	ASCII_SPINNER_FRAMES,
	GAUGE_EMPTY,
	GAUGE_FILLED,
	isAsciiGlyphMode,
	resolveFoldGlyphs,
	resolveGaugeGlyphs,
	resolveSpinnerFrames,
	resolveTreeConnectors,
} from "../src/modes/interactive/components/glyph-resolver.js";
import { systemMessageLabel } from "../src/modes/interactive/components/system-message-glyphs.js";

describe("isAsciiGlyphMode / glyph resolver", () => {
	afterEach(() => {
		delete process.env.PIT_ASCII;
		delete process.env.PIT_ASCII_GAUGE;
		if (process.env.TERM === "dumb") delete process.env.TERM;
	});

	it("is off by default", () => {
		delete process.env.PIT_ASCII;
		delete process.env.PIT_ASCII_GAUGE;
		expect(isAsciiGlyphMode({})).toBe(false);
	});

	it("accepts PIT_ASCII, PIT_ASCII_GAUGE alias, and TERM=dumb", () => {
		expect(isAsciiGlyphMode({ PIT_ASCII: "1" })).toBe(true);
		expect(isAsciiGlyphMode({ PIT_ASCII: "true" })).toBe(true);
		expect(isAsciiGlyphMode({ PIT_ASCII_GAUGE: "1" })).toBe(true);
		expect(isAsciiGlyphMode({ TERM: "dumb" })).toBe(true);
	});

	it("gauge falls back to true ASCII under ASCII mode", () => {
		expect(resolveGaugeGlyphs({}).filled).toBe(GAUGE_FILLED);
		expect(resolveGaugeGlyphs({}).empty).toBe(GAUGE_EMPTY);
		const ascii = resolveGaugeGlyphs({ PIT_ASCII: "1" });
		expect(ascii.filled).toBe("#");
		expect(ascii.empty).toBe(".");
	});

	it("tree connectors and fold glyphs fall back under ASCII mode", () => {
		const tree = resolveTreeConnectors({ PIT_ASCII: "1" });
		expect(tree.branch).toBe("+");
		expect(tree.last).toBe("+");
		expect(tree.pipe).toBe("|");
		const fold = resolveFoldGlyphs({ PIT_ASCII: "1" });
		expect(fold.folded).toBe("+");
		expect(fold.expanded).toBe("-");
	});

	it("spinner uses |/-\\ under ASCII mode", () => {
		expect(resolveSpinnerFrames({})).toEqual(SPINNER_FRAMES);
		expect([...resolveSpinnerFrames({ PIT_ASCII: "1" })]).toEqual([...ASCII_SPINNER_FRAMES]);
	});

	it("system message labels use ASCII glyphs under PIT_ASCII", () => {
		process.env.PIT_ASCII = "1";
		expect(systemMessageLabel("compaction")).toBe("* Compaction");
		expect(systemMessageLabel("steer")).toBe("> Steer");
		delete process.env.PIT_ASCII;
		expect(systemMessageLabel("compaction")).toContain("Compaction");
	});
});
