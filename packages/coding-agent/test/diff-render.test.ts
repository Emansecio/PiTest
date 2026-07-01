import { beforeAll, describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("renderDiff", () => {
	beforeAll(() => initTheme("dark"));

	it("renders line numbers separately from diff body colors", () => {
		const diff = "-  12 old line\n+  12 new line";
		const lines = renderDiff(diff).split("\n");
		expect(lines.length).toBe(2);
		const removed = stripAnsi(lines[0]);
		const added = stripAnsi(lines[1]);
		expect(removed).toMatch(/^-12 old line$/);
		expect(added).toMatch(/^\+12 new line$/);
		expect(lines[0]).toContain("\x1b[");
	});
});
