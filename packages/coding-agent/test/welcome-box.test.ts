/**
 * Smoke + width-invariant tests for the startup WelcomeBox. The TUI host crashes
 * if a custom component emits a line wider than the viewport ("Rendered line
 * exceeds terminal width"), so every render path must stay within `width`.
 */

import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { CenteredText } from "../src/modes/interactive/components/centered-text.js";
import { WelcomeBox, type WelcomeBoxData } from "../src/modes/interactive/components/welcome-box.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const BASE: WelcomeBoxData = {
	appName: "pit",
	version: "0.4.2",
	tagline: "coding agent in your terminal",
	cwdDisplay: "PiTest",
	branch: "main",
};

const HERO: WelcomeBoxData = { ...BASE, hero: true };

describe("WelcomeBox", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the wordmark, tagline, version and cwd/branch on the default name", () => {
		const out = new WelcomeBox(BASE).render(80);
		const plain = out.map(stripAnsi).join("\n");
		expect(plain).toContain("v0.4.2");
		expect(plain).toContain("coding agent in your terminal");
		expect(plain).toContain("Workspace");
		expect(plain).toContain("PiTest");
		expect(plain).toContain("(main)");
		// The active model lives in the footer, not the welcome.
		expect(plain).not.toContain("thinking");
		// Rounded card frame closes the identity block.
		expect(stripAnsi(out[out.length - 1])).toMatch(/^╰─+╯$/);
		expect(stripAnsi(out[0])).toMatch(/^╭─+╮$/);
	});

	it("applies paddingY=1 inside the card at width 80 (>= 60)", () => {
		const out = new WelcomeBox(BASE).render(80).map(stripAnsi);
		// Top border, then a blank padded row, then content.
		expect(out[0]).toMatch(/^╭─+╮$/);
		expect(out[1]).toMatch(/^│\s*│$/);
		expect(out[out.length - 1]).toMatch(/^╰─+╯$/);
		expect(out[out.length - 2]).toMatch(/^│\s*│$/);
	});

	it("never emits a line wider than the viewport, across widths", () => {
		for (const width of [120, 80, 60, 40, 24, 12]) {
			for (const line of new WelcomeBox(BASE).render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("surfaces the session name when resuming", () => {
		const plain = new WelcomeBox({ ...BASE, resumedSessionName: "auth-refactor" })
			.render(80)
			.map(stripAnsi)
			.join("\n");
		expect(plain).toContain("Resuming · auth-refactor");
		expect(plain).toContain("Workspace");
		expect(plain).toContain("PiTest");
	});

	it("shows the home directory label even without branch context", () => {
		const plain = new WelcomeBox({ ...BASE, cwdDisplay: "~ (home)", branch: undefined })
			.render(80)
			.map(stripAnsi)
			.join("\n");
		expect(plain).toContain("Workspace");
		expect(plain).toContain("~ (home)");
	});

	it("still shows the cwd in home when a branch gives it context", () => {
		const plain = new WelcomeBox({ ...BASE, cwdDisplay: "~ (home)", branch: "main" })
			.render(80)
			.map(stripAnsi)
			.join("\n");
		expect(plain).toContain("Workspace");
		expect(plain).toContain("~ (home)");
		expect(plain).toContain("(main)");
	});

	it("shows shell cwd divergence on the workspace line", () => {
		const plain = new WelcomeBox({
			...BASE,
			cwdDisplay: "~ (home)",
			shellCwdNote: "shell: ~/pit",
			branch: undefined,
		})
			.render(80)
			.map(stripAnsi)
			.join("\n");
		expect(plain).toContain("shell: ~/pit");
	});

	it("drops the block wordmark for a custom app name", () => {
		const plain = new WelcomeBox({ ...BASE, appName: "scout" }).render(80).map(stripAnsi).join("\n");
		expect(plain).toContain("scout");
		// The half-block PIT wordmark only ships for the default "pit" name.
		expect(plain).not.toContain("█");
	});
});

describe("WelcomeBox — hero (fresh session)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the borderless centered hero with wordmark, tagline, version and workspace", () => {
		const out = new WelcomeBox(HERO).render(80);
		const plain = out.map(stripAnsi);
		const joined = plain.join("\n");
		expect(joined).toContain("██");
		expect(joined).toContain("coding agent in your terminal · v0.4.2");
		expect(joined).toContain("Workspace");
		expect(joined).toContain("(main)");
		// Borderless: no card frame in hero mode.
		expect(joined).not.toContain("╭");
		// Centered: the wordmark block starts well past the left margin at 80 cols.
		expect(plain[0]).toMatch(/^ {20,}█/);
	});

	it("never emits a line wider than the viewport, across widths", () => {
		for (const width of [120, 80, 60, 40, 39, 24, 12]) {
			for (const line of new WelcomeBox(HERO).render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("falls back to the compact card below the hero minimum width", () => {
		const out = new WelcomeBox(HERO).render(39);
		expect(stripAnsi(out[0])).toMatch(/^╭─+╮$/);
	});

	it("falls back to the compact card when resuming", () => {
		const out = new WelcomeBox({ ...HERO, resumedSessionName: "auth-refactor" }).render(80);
		expect(stripAnsi(out[0])).toMatch(/^╭─+╮$/);
		expect(out.map(stripAnsi).join("\n")).toContain("Resuming · auth-refactor");
	});

	it("falls back to the compact card on a custom app name", () => {
		const out = new WelcomeBox({ ...HERO, appName: "scout" }).render(80);
		expect(stripAnsi(out[0])).toMatch(/^╭─+╮$/);
	});

	it("honors a wordmarkColor override on the hero wordmark", () => {
		const out = new WelcomeBox({ ...HERO, wordmarkColor: (s) => `<<${s}>>` }).render(80);
		expect(out[0]).toContain("<<");
	});

	it("draws the wordmark with solid blocks only — no line-drawing shell glyphs", () => {
		const joined = new WelcomeBox(HERO).render(80).map(stripAnsi).join("\n");
		// The old ANSI-shadow figlet framed each glyph in box-drawing chars that
		// read as a render echo; the solid-block font must not reintroduce them.
		expect(joined).not.toMatch(/[╔╗╚╝═║╠╣╦╩╬]/);
	});
});

describe("CenteredText", () => {
	it("centers the line and honors paddingY", () => {
		const out = new CenteredText("hello", 1).render(21);
		expect(out).toEqual(["", "        hello", ""]);
	});

	it("never emits a line wider than the viewport, across widths", () => {
		const text = "Describe a task to get started · / commands · ! bash · drop files to attach";
		for (const width of [120, 80, 40, 12]) {
			for (const line of new CenteredText(text, 1).render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("WelcomeBox — render memoization", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("returns the same array instance across frames with unchanged data and width", () => {
		const box = new WelcomeBox(BASE);
		const first = box.render(80);
		const second = box.render(80);
		expect(second).toBe(first);
	});

	it("recomputes when the width changes, then memoizes at the new width", () => {
		const box = new WelcomeBox(BASE);
		const w80 = box.render(80);
		const w60 = box.render(60);
		expect(w60).not.toBe(w80);
		expect(box.render(60)).toBe(w60);
	});

	it("setData busts the memo and the output reflects the new data", () => {
		const box = new WelcomeBox(BASE);
		const before = box.render(80);
		box.setData({ ...BASE, version: "9.9.9" });
		const after = box.render(80);
		expect(after).not.toBe(before);
		expect(after.map(stripAnsi).join("\n")).toContain("v9.9.9");
	});

	it("invalidate() drops the memo and reassembles byte-identically", () => {
		const box = new WelcomeBox(BASE);
		const first = box.render(80);
		box.invalidate();
		const second = box.render(80);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});

	it("never serves the memo while a wordmarkColor closure is present", () => {
		// wordmarkColor may be a time-varying ease closure (logo fade on mount) —
		// the same (width, data) pair can legitimately change bytes per frame, so
		// the memo must be bypassed entirely while it is set.
		const box = new WelcomeBox({ ...BASE, wordmarkColor: (s) => s });
		const first = box.render(80);
		const second = box.render(80);
		expect(second).not.toBe(first);
		expect(second).toEqual(first);
	});
});
