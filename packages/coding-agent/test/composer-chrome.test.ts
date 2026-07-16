import { stripVTControlCharacters } from "node:util";
import { Text, visibleWidth } from "@pit/tui";
import { describe, expect, test } from "vitest";
import { ComposerChrome } from "../src/modes/interactive/components/composer-chrome.ts";

function plain(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line));
}

describe("ComposerChrome", () => {
	test("frames the editor and drops the metadata into a strip below the box", () => {
		const composer = new ComposerChrome(new Text("message", 0, 0), new Text("workspace        model", 0, 0));
		const lines = plain(composer.render(30));

		// Frame wraps only the editor; the bottom border closes it off.
		expect(lines[0]).toMatch(/^╭─+╮$/);
		expect(lines[1]).toMatch(/^│message\s+│$/);
		expect(lines[2]).toMatch(/^╰─+╯$/);
		// Footer sits OUTSIDE the frame, indented one column, not boxed.
		expect(lines[3]).toMatch(/^ workspace\s+model$/);
		expect(lines[3]).not.toContain("│");
		// The framed rows are exactly the requested width; the footer strip is free
		// to be shorter (it's a status line, not a filled row).
		for (const line of lines.slice(0, 3)) expect(visibleWidth(line)).toBe(30);
		expect(visibleWidth(lines[3])).toBeLessThanOrEqual(30);
	});

	test("keeps multiline content boxed and the footer outside at the requested width", () => {
		const composer = new ComposerChrome(new Text("first\nsecond", 0, 0), new Text("meta", 0, 0));
		const lines = plain(composer.render(10));

		// lines: top, first, second, bottom, footer
		expect(lines[0]).toMatch(/^╭─+╮$/);
		expect(lines.slice(1, 3).every((line) => line.startsWith("│") && line.endsWith("│"))).toBe(true);
		expect(lines[3]).toMatch(/^╰─+╯$/);
		expect(lines[4]).toMatch(/^ meta$/);
		for (const line of lines.slice(0, 4)) expect(visibleWidth(line)).toBe(10);
		expect(visibleWidth(lines[4])).toBeLessThanOrEqual(10);
	});

	test("replaces footer content without replacing the composer", () => {
		const composer = new ComposerChrome(new Text("message", 0, 0), new Text("old", 0, 0));
		expect(plain(composer.render(20)).join("\n")).toContain("old");

		composer.setFooter(new Text("new", 0, 0));
		expect(plain(composer.render(20)).join("\n")).not.toContain("old");
		expect(plain(composer.render(20)).join("\n")).toContain("new");
	});
});
