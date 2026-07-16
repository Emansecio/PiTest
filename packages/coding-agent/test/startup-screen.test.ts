import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@pit/tui";
import { beforeAll, describe, expect, test } from "vitest";
import { StartupScreen } from "../src/modes/interactive/components/startup-screen.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
});

describe("StartupScreen", () => {
	test("renders the block PIT wordmark on wide viewports", () => {
		const plain = new StartupScreen()
			.render(80)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		expect(plain).toContain("██████");
	});

	test.each([18, 36, 64, 96])("keeps every line inside width %i", (width) => {
		const screen = new StartupScreen();
		const lines = screen.render(width);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	test("contains exactly the required welcome and help copy", () => {
		const plain = new StartupScreen()
			.render(80)
			.map((line) => stripVTControlCharacters(line))
			.join("\n");
		expect(plain).toContain("Welcome to Pit");
		expect(plain).toContain("/help for help");
		expect(plain).not.toContain("Coding agent in your terminal");
	});
});
