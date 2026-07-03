import { beforeAll, describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("renderDiff", () => {
	beforeAll(() => initTheme("dark"));

	it("renders a dim number gutter with the sign next to the body", () => {
		const diff = "-  12 old line\n+  12 new line";
		const lines = renderDiff(diff).split("\n");
		expect(lines.length).toBe(2);
		const removed = stripAnsi(lines[0]);
		const added = stripAnsi(lines[1]);
		expect(removed).toBe("  12 - old line");
		expect(added).toBe("  12 + new line");
		expect(lines[0]).toContain("\x1b[");
	});

	it("keeps bodies column-aligned across digit-width boundaries", () => {
		const diff = "  99 ctx\n-100 old\n+100 new";
		const lines = renderDiff(diff).split("\n").map(stripAnsi);
		expect(lines[0]).toBe(" 99   ctx");
		expect(lines[1]).toBe("100 - old");
		expect(lines[2]).toBe("100 + new");
		// Every body starts at the same column.
		expect(new Set(["ctx", "old", "new"].map((body, i) => lines[i].indexOf(body))).size).toBe(1);
	});

	it("renders the numberless hunk-skip marker as a dim ellipsis in the body column", () => {
		const diff = "  10 ctx\n     ...\n-100 old\n+100 new";
		const lines = renderDiff(diff).split("\n").map(stripAnsi);
		expect(lines[1]).toBe("      …");
		expect(lines[1].indexOf("…")).toBe(lines[0].indexOf("ctx"));
	});

	it("keeps intra-line bold emphasis on single-line modifications", () => {
		const diff = "- 5 const a = 1;\n+ 5 const a = 2;";
		const lines = renderDiff(diff).split("\n");
		expect(lines[0]).toContain("\x1b[1m");
		expect(lines[1]).toContain("\x1b[1m");
	});
});
