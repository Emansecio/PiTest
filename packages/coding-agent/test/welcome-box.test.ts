/**
 * Smoke + width-invariant tests for the startup WelcomeBox. The TUI host crashes
 * if a custom component emits a line wider than the viewport ("Rendered line
 * exceeds terminal width"), so every render path must stay within `width`.
 */

import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { WelcomeBox, type WelcomeBoxData } from "../src/modes/interactive/components/welcome-box.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

const BASE: WelcomeBoxData = {
	appName: "pit",
	version: "0.4.2",
	tagline: "coding agent in your terminal",
	cwdDisplay: "~/PiTest",
	branch: "main",
};

describe("WelcomeBox", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("renders the wordmark, tagline, version and cwd/branch on the default name", () => {
		const out = new WelcomeBox(BASE).render(80);
		const plain = out.map(stripAnsi).join("\n");
		expect(plain).toContain("v0.4.2");
		expect(plain).toContain("coding agent in your terminal");
		expect(plain).toContain("~/PiTest (main)");
		// The active model lives in the footer, not the welcome.
		expect(plain).not.toContain("thinking");
		// A single closing rule — no heavy top rule above the logo.
		expect(stripAnsi(out[out.length - 1])).toMatch(/^─+$/);
		expect(stripAnsi(out[0])).not.toMatch(/^─+$/);
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
		// The cwd row is replaced by the session name when resuming.
		expect(plain).not.toContain("~/PiTest (main)");
	});

	it("suppresses a lone '~' cwd row in the home dir with no project context", () => {
		const out = new WelcomeBox({ ...BASE, cwdDisplay: "~", branch: undefined }).render(80);
		const plain = out.map(stripAnsi);
		// No body row is just "~" (the row may carry the wordmark prefix + spaces).
		expect(plain.some((l) => l.trimEnd().endsWith("~"))).toBe(false);
	});

	it("still shows the cwd in home when a branch gives it context", () => {
		const plain = new WelcomeBox({ ...BASE, cwdDisplay: "~", branch: "main" }).render(80).map(stripAnsi).join("\n");
		expect(plain).toContain("~ (main)");
	});

	it("drops the block wordmark for a custom app name", () => {
		const plain = new WelcomeBox({ ...BASE, appName: "scout" }).render(80).map(stripAnsi).join("\n");
		expect(plain).toContain("scout");
		// The half-block wordmark only ships for the default "pit" name.
		expect(plain).not.toContain("█");
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
