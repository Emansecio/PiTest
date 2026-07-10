import { beforeAll, describe, expect, it } from "vitest";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
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

	it("without lang, added/removed bodies still use the solid diff tint", () => {
		const diff = "+ 1 hello";
		const rendered = renderDiff(diff);
		const addedAnsi = theme.getFgAnsi("toolDiffAdded");
		expect(rendered).toContain(addedAnsi);
		// Body is wrapped in the line tint (not syntax-only).
		expect(stripAnsi(rendered)).toBe(" 1 + hello");
	});

	it("with lang, syntax-colors the body instead of a solid toolDiff wrap on the whole line", () => {
		const diff = "+ 1 const x = 1;";
		const withLang = renderDiff(diff, { lang: "typescript" });
		const withoutLang = renderDiff(diff);

		expect(stripAnsi(withLang)).toBe(stripAnsi(withoutLang));
		expect(withLang).toContain("\x1b[");

		// Solid-tint path opens toolDiffAdded around the whole body. Syntax path
		// keeps the bold + sign in toolDiffAdded but colors keywords via syntax*
		// tokens — so the body should carry syntaxKeyword (or similar) ANSI that
		// the no-lang path does not.
		const keywordAnsi = theme.getFgAnsi("syntaxKeyword");
		expect(withLang).toContain(keywordAnsi);
		expect(withoutLang).not.toContain(keywordAnsi);
	});

	it("with path, resolves language from the extension", () => {
		const diff = "+ 1 const x = 1;";
		const viaPath = renderDiff(diff, { path: "src/foo.ts" });
		const viaLang = renderDiff(diff, { lang: "typescript" });
		expect(viaPath).toBe(viaLang);
	});

	it("applies word-level bold on equal-count multi-line hunks", () => {
		const diff = ["- 1 const a = 1;", "- 2 const b = 1;", "+ 1 const a = 2;", "+ 2 const b = 2;"].join("\n");
		const lines = renderDiff(diff).split("\n");
		expect(lines).toHaveLength(4);
		// Each paired line should emphasize the changed token.
		for (const line of lines) {
			expect(line).toContain("\x1b[1m");
		}
	});

	it("renders unequal multi-line hunks without crashing", () => {
		const diff = ["- 1 first", "- 2 second", "+ 1 only"].join("\n");
		const lines = renderDiff(diff).split("\n");
		expect(lines).toHaveLength(3);
		expect(stripAnsi(lines[0])).toBe(" 1 - first");
		expect(stripAnsi(lines[1])).toBe(" 2 - second");
		expect(stripAnsi(lines[2])).toBe(" 1 + only");
	});
});
