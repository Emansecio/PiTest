import { HEARTBEAT_CYCLE_MS, resetCapabilitiesCache, setCapabilities, visibleWidth } from "@pit/tui";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	applyColumnGradient,
	h1Gradient,
	shimmerColorAt,
	wordmarkGradient,
} from "../src/modes/interactive/theme/color-interpolation.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Lone UTF-16 surrogates indicate a split emoji grapheme. */
function hasLoneSurrogate(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next < 0xdc00 || next > 0xdfff) return true;
		}
		if (code >= 0xdc00 && code <= 0xdfff) {
			const prev = text.charCodeAt(i - 1);
			if (prev < 0xd800 || prev > 0xdbff) return true;
		}
	}
	return false;
}

beforeAll(() => {
	initTheme("dark");
});

describe("applyColumnGradient", () => {
	it("colors each ASCII grapheme without splitting", () => {
		const plain = "ABC";
		const colored: string[] = [];
		const out = applyColumnGradient(plain, (col, cols) => {
			return (segment: string) => {
				colored.push(`${col}/${cols}:${segment}`);
				return segment;
			};
		});
		expect(stripAnsi(out)).toBe(plain);
		expect(colored).toEqual(["0/3:A", "1/3:B", "2/3:C"]);
	});

	it("does not split emoji in H1 text", () => {
		const text = "# Title ✨";
		const out = h1Gradient(text);
		expect(hasLoneSurrogate(stripAnsi(out))).toBe(false);
		expect(stripAnsi(out)).toBe(text);
		expect(visibleWidth(stripAnsi(out))).toBe(visibleWidth(text));
	});

	it("colors wide CJK graphemes as whole clusters", () => {
		const text = "# 标题";
		const segments: string[] = [];
		const out = applyColumnGradient(text, () => (segment: string) => {
			segments.push(segment);
			return segment;
		});
		expect(stripAnsi(out)).toBe(text);
		expect(segments.some((s) => s === "标")).toBe(true);
		expect(segments.some((s) => s === "题")).toBe(true);
		expect(segments.every((s) => !hasLoneSurrogate(s))).toBe(true);
	});
});

describe("wordmarkGradient", () => {
	it("preserves ASCII wordmark byte-for-byte when stripped", () => {
		const wm = "█▀█ █ ▀█▀";
		expect(stripAnsi(wordmarkGradient(wm))).toBe(wm);
	});
});

describe("shimmerColorAt", () => {
	afterAll(() => {
		resetCapabilitiesCache();
		initTheme("dark");
	});

	it("advances the bright band between two half-cycle-apart times (truecolor)", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
		const label = "assembling context";
		const a = shimmerColorAt(0, undefined, HEARTBEAT_CYCLE_MS)(label);
		const b = shimmerColorAt(HEARTBEAT_CYCLE_MS / 2, undefined, HEARTBEAT_CYCLE_MS)(label);
		// Only colors change — the visible text and its width are untouched.
		expect(stripAnsi(a)).toBe(label);
		expect(stripAnsi(b)).toBe(label);
		expect(visibleWidth(stripAnsi(a))).toBe(visibleWidth(label));
		expect(visibleWidth(stripAnsi(b))).toBe(visibleWidth(label));
		// Band has moved → different ANSI output.
		expect(a).not.toBe(b);
	});

	it("does not split emoji graphemes as the band sweeps", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
		const label = "packing ✨ files";
		const out = shimmerColorAt(HEARTBEAT_CYCLE_MS / 3)(label);
		expect(stripAnsi(out)).toBe(label);
		expect(hasLoneSurrogate(stripAnsi(out))).toBe(false);
	});

	it("falls back to muted-only without truecolor (no sweep)", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		initTheme("dark");
		const label = "assembling context";
		expect(shimmerColorAt(500)(label)).toBe(theme.fg("muted", label));
		// Time-invariant: same output regardless of `now`.
		expect(shimmerColorAt(0)(label)).toBe(shimmerColorAt(900)(label));
	});

	it("falls back to muted-only under reduced motion even with truecolor", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark");
		const label = "assembling context";
		process.env.PIT_NO_MOTION = "1";
		try {
			expect(shimmerColorAt(0)(label)).toBe(theme.fg("muted", label));
		} finally {
			delete process.env.PIT_NO_MOTION;
		}
	});
});
