import { beforeAll, describe, expect, it } from "vitest";
import {
	formatContextFilesHeader,
	formatLoadedSectionHeader,
	pluralCountLabel,
	renderCompactItemRow,
	renderContextFilesBody,
	renderSupplementaryContext,
} from "../src/modes/interactive/components/context-display.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";
import { ADVERSARIAL_TEXT, BORDER_WIDTHS, expectFitsWidth } from "./helpers/render-width.js";

describe("renderSupplementaryContext", () => {
	beforeAll(() => initTheme(undefined, false));

	it("returns [] for empty text", () => {
		expect(renderSupplementaryContext("   ", 80)).toEqual([]);
	});

	it("renders a labeled tree with connectors", () => {
		const out = stripAnsi(renderSupplementaryContext("pick carefully\nsecond line", 80).join("\n"));
		expect(out).toContain("Context");
		expect(out).toContain("pick carefully");
		expect(out).toContain("second line");
		expect(out).toMatch(/├─/);
		expect(out).toMatch(/└─/);
	});

	it("never emits a line wider than the terminal", () => {
		for (const [name, text] of Object.entries(ADVERSARIAL_TEXT)) {
			for (const width of BORDER_WIDTHS) {
				const lines = renderSupplementaryContext(`ctx ${text}`, width);
				expectFitsWidth(lines, width, `supplementary-context[${name}]@${width}`);
			}
		}
	});
});

describe("renderContextFilesBody", () => {
	beforeAll(() => initTheme(undefined, false));

	it("collapsed joins paths on one tree row", () => {
		const out = stripAnsi(renderContextFilesBody(["AGENTS.md", "~/.pit/agent/AGENTS.md"], true));
		expect(out).toContain("└─");
		expect(out).toContain("AGENTS.md");
		expect(out).toContain("~/.pit/agent/AGENTS.md");
		expect(out).not.toMatch(/├─/);
	});

	it("expanded lists each path on its own row", () => {
		const out = stripAnsi(renderContextFilesBody(["a.md", "b.md"], false));
		expect(out).toContain("├─ a.md");
		expect(out).toContain("└─ b.md");
	});

	it("header includes file count", () => {
		expect(stripAnsi(formatContextFilesHeader(2))).toContain("2 files");
		expect(stripAnsi(formatContextFilesHeader(1))).toContain("1 file");
	});

	it("formatLoadedSectionHeader and renderCompactItemRow share the startup pattern", () => {
		expect(stripAnsi(formatLoadedSectionHeader("Skills", pluralCountLabel(3, "skill", "skills")))).toContain(
			"Skills",
		);
		expect(stripAnsi(formatLoadedSectionHeader("Skills", pluralCountLabel(3, "skill", "skills")))).toContain(
			"3 skills",
		);
		const row = stripAnsi(renderCompactItemRow(["commit", "review"]));
		expect(row).toContain("└─");
		expect(row).toContain("commit, review");
	});
});
