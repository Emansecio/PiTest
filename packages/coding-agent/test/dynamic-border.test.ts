/**
 * Identity/memoization tests for DynamicBorder: a settled border line is
 * byte-stable per width, so render must return the SAME array instance across
 * frames (letting parent containers reuse their flatten caches) and reallocate
 * only on width change or invalidate() (the theme-change path — `ui.invalidate()`
 * cascades to every in-tree child).
 */

import { beforeAll, describe, expect, it } from "vitest";
import { DynamicBorder } from "../src/modes/interactive/components/dynamic-border.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

describe("DynamicBorder", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders a full-width rule", () => {
		const out = new DynamicBorder().render(40);
		expect(out).toHaveLength(1);
		expect(stripAnsi(out[0])).toBe("─".repeat(40));
	});

	it("returns the same array instance across frames at the same width", () => {
		const border = new DynamicBorder();
		const first = border.render(40);
		const second = border.render(40);
		expect(second).toBe(first);
	});

	it("recomputes when the width changes, then memoizes at the new width", () => {
		const border = new DynamicBorder();
		const w40 = border.render(40);
		const w20 = border.render(20);
		expect(w20).not.toBe(w40);
		expect(stripAnsi(w20[0])).toBe("─".repeat(20));
		expect(border.render(20)).toBe(w20);
	});

	it("invalidate() drops the memo and reassembles byte-identically", () => {
		const border = new DynamicBorder();
		const first = border.render(40);
		border.invalidate();
		const second = border.render(40);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});

	it("uses the explicit color function when given", () => {
		const border = new DynamicBorder((s) => theme.fg("accent", s));
		const out = border.render(10);
		expect(stripAnsi(out[0])).toBe("─".repeat(10));
		// Memoization still applies with a custom color fn.
		expect(border.render(10)).toBe(out);
	});
});
