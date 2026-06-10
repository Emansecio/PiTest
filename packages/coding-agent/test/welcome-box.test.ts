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
		// Top and bottom rules frame the block.
		expect(stripAnsi(out[0])).toMatch(/^─+$/);
		expect(stripAnsi(out[out.length - 1])).toMatch(/^─+$/);
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

	it("drops the block wordmark for a custom app name", () => {
		const plain = new WelcomeBox({ ...BASE, appName: "scout" }).render(80).map(stripAnsi).join("\n");
		expect(plain).toContain("scout");
		// The half-block wordmark only ships for the default "pit" name.
		expect(plain).not.toContain("█");
	});
});
