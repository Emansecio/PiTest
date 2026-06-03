/**
 * Shared render-width assertions for TUI component tests.
 *
 * The render pipeline now truncates an over-wide line in production instead of
 * crashing (see TUI.doRender's last-resort net), but that is *recovery*, not
 * *correctness* — a component that over-renders still looks clipped for a frame.
 * These helpers let a component test prove it never emits a line wider than the
 * terminal, across a spread of border widths and against adversarial content
 * (full-width CJK, emoji, embedded ANSI) that defeats naive `.length`-based
 * budgeting — the exact bug class behind the todo-overlay overflow crash.
 *
 * Mirror of @pit/tui's assertComponentWidth, but as a Vitest matcher so it
 * composes with the existing per-component width suites.
 */
import { visibleWidth } from "@pit/tui";
import { expect } from "vitest";

/** Narrow→wide widths that tend to expose off-by-N truncation math. */
export const BORDER_WIDTHS = [20, 40, 80, 120] as const;

/**
 * Strings engineered to break width math. Each value is intentionally far wider
 * than any BORDER_WIDTHS entry, so a correct component must truncate every one:
 *  - longAscii  — basic overflow (1 col per char).
 *  - cjk        — full-width glyphs (2 cols each), so `.length` undercounts ~2x.
 *  - emoji      — multi-codepoint pictographs (2 cols), `.length` overcounts.
 *  - mixed      — ASCII + CJK + emoji in one string (realistic worst case).
 *  - ansiWrapped — long text wrapped in SGR codes (bytes that occupy 0 cols).
 */
export const ADVERSARIAL_TEXT: Record<string, string> = {
	longAscii: "x".repeat(400),
	cjk: "实现待办事项渲染溢出修复缩短行".repeat(20),
	emoji: "🎉🚀✨🔥".repeat(40),
	mixed: `Fix ${"项目".repeat(30)} 🎉 ${"y".repeat(60)}`,
	ansiWrapped: `\x1b[38;2;1;2;3m${"z".repeat(300)}\x1b[39m`,
};

/**
 * Assert every line fits `width`. Names the offending line index + its visible
 * width and quotes the head of the line, so a failure points straight at the
 * culprit instead of a bare boolean.
 */
export function expectFitsWidth(lines: string[], width: number, label = "render"): void {
	for (let i = 0; i < lines.length; i++) {
		const w = visibleWidth(lines[i]);
		expect(
			w,
			`${label}: line ${i} visibleWidth=${w} exceeds terminal width ${width}\n  line=${JSON.stringify(lines[i].slice(0, 120))}`,
		).toBeLessThanOrEqual(width);
	}
}
