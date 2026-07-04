import { HEARTBEAT_CYCLE_MS, resetCapabilitiesCache, setCapabilities } from "@pit/tui";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getRgb, interpolateFg, shimmerColorAt } from "../src/modes/interactive/theme/color-interpolation.ts";
import { getThemeByName, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("theme Proxy bound-method cache (perf)", () => {
	beforeAll(() => {
		initTheme("dark");
	});
	afterAll(() => {
		initTheme("dark");
	});

	it("returns the same bound function reference for repeated property access on one instance", () => {
		initTheme("dark");
		const fgA = theme.fg;
		const fgB = theme.fg;
		// Bound-method cache (WeakMap<Theme, Map<prop, bound>>) means the second
		// `.fg` access doesn't allocate a new bound function.
		expect(fgA).toBe(fgB);
	});

	it("still resolves `this` to the real Theme instance (not the Proxy) inside methods", () => {
		initTheme("dark");
		// getThinkingBorderColor returns a closure that calls `this.fg(...)`
		// internally; if `this` were still the Proxy this would still work, but
		// this exercises the internal-access path the bound-method cache targets.
		const colorize = theme.getThinkingBorderColor("high");
		expect(colorize("x")).toBe(theme.fg("thinkingHigh", "x"));
	});

	it("continues to reflect a live theme switch (functionality preserved)", () => {
		initTheme("dark");
		const darkAccent = theme.fg("accent", "x");
		initTheme("light");
		const lightAccent = theme.fg("accent", "x");
		expect(darkAccent).not.toBe(lightAccent);
	});

	it("produces working (if freshly-bound) methods after a theme instance swap", () => {
		initTheme("dark");
		const fgDark = theme.fg;
		initTheme("light");
		initTheme("dark"); // swap back — a NEW Theme instance is constructed each time
		const fgDarkAgain = theme.fg;
		// Same color values (dark theme reloaded), output must match even though the
		// underlying Theme object — and therefore the bound function — is a new one.
		expect(fgDarkAgain("accent", "x")).toBe(fgDark("accent", "x"));
	});
});

describe("getRgb cache", () => {
	it("caches the parsed Rgb object per theme instance (same reference on repeat calls)", () => {
		const dark = getThemeByName("dark");
		expect(dark).toBeDefined();
		if (!dark) return;
		const first = getRgb(dark, "accent");
		const second = getRgb(dark, "accent");
		expect(first).toBeDefined();
		// Same instance + same color -> cache hit -> identical object reference.
		expect(second).toBe(first);
	});

	it("renews the cache for a new theme instance (even with identical colors)", () => {
		const darkA = getThemeByName("dark");
		const darkB = getThemeByName("dark"); // loadTheme() builds a fresh Theme object per call
		expect(darkA).toBeDefined();
		expect(darkB).toBeDefined();
		if (!darkA || !darkB) return;
		expect(darkA).not.toBe(darkB); // sanity: genuinely different instances
		const rgbA = getRgb(darkA, "accent");
		const rgbB = getRgb(darkB, "accent");
		expect(rgbB).not.toBe(rgbA); // new instance -> fresh cache entry, not reused
		expect(rgbB).toEqual(rgbA); // same theme JSON -> same color values
	});

	it("caches through the shared theme Proxy and renews after a real theme switch", () => {
		initTheme("dark");
		const darkRgb = getRgb(theme, "accent");
		initTheme("light");
		const lightRgb = getRgb(theme, "accent");
		initTheme("dark");
		expect(darkRgb).toBeDefined();
		expect(lightRgb).toBeDefined();
		expect(lightRgb).not.toEqual(darkRgb);
	});
});

describe("shimmerColorAt LUT quantization", () => {
	afterEach(() => {
		resetCapabilitiesCache();
		initTheme("dark");
	});

	it("preserves visible characters and width exactly (only colors change)", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
		const label = "assembling context for the next turn";
		for (const now of [0, HEARTBEAT_CYCLE_MS / 4, HEARTBEAT_CYCLE_MS / 2, (HEARTBEAT_CYCLE_MS * 3) / 4]) {
			const painted = shimmerColorAt(now)(label);
			expect(stripAnsi(painted)).toBe(label);
		}
	});

	it("only emits truecolor foreground SGR sequences (LUT prefixes are well-formed)", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
		const label = "packing files";
		const painted = shimmerColorAt(HEARTBEAT_CYCLE_MS / 3)(label);
		const sgrs = painted.match(/\x1b\[[0-9;]*m/g) ?? [];
		for (const sgr of sgrs) {
			expect(sgr).toMatch(/^\x1b\[(38;2;\d{1,3};\d{1,3};\d{1,3}|39)m$/);
		}
	});
});

describe("interpolateFg via getRgb cache", () => {
	afterEach(() => {
		resetCapabilitiesCache();
		initTheme("dark");
	});

	it("reflects a theme switch (no stale cached color leaks across instances)", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
		const darkBlend = interpolateFg("accent", "thinkingXhigh", 0.5)?.("x");
		initTheme("light");
		const lightBlend = interpolateFg("accent", "thinkingXhigh", 0.5)?.("x");
		expect(darkBlend).toBeDefined();
		expect(lightBlend).toBeDefined();
		expect(darkBlend).not.toBe(lightBlend);
	});
});
