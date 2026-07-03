import { beforeAll, describe, expect, test } from "vitest";
import { collapseAnnotatedBlocks } from "../src/modes/interactive/components/annotated-block-collapse.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

// The folded trailer now routes through the canonical `moreLinesTrailer`
// (`… +N hint lines (<key> to expand)`), which owns its own muted styling and
// keybinding lookup — so the injected `muted`/`expandHint` no longer shape the
// trailer. Assert on the stripped text to stay theme-agnostic.
const muted = (s: string) => `[muted:${s}]`;
const expandHint = "ctrl+o to expand";

beforeAll(() => initTheme("dark"));

describe("collapseAnnotatedBlocks", () => {
	test("returns text unchanged when there is no annotated block", () => {
		const input = "ENOENT: no such file or directory";
		expect(collapseAnnotatedBlocks(input, { expanded: false, muted, expandHint })).toBe(input);
	});

	test("returns text unchanged when expanded", () => {
		const input = "Error\n\n[hint] first\n[hint] second";
		expect(collapseAnnotatedBlocks(input, { expanded: true, muted, expandHint })).toBe(input);
	});

	test("does not collapse a single annotated line", () => {
		const input = "Error\n\n[hint] use find()";
		expect(collapseAnnotatedBlocks(input, { expanded: false, muted, expandHint })).toBe(input);
	});

	test("collapses multiple consecutive hint lines and keeps the first", () => {
		const input = "ENOENT: missing\n\n[hint] line one\n[hint] line two\n[hint] line three";
		const out = collapseAnnotatedBlocks(input, { expanded: false, muted, expandHint });
		const lines = out.split("\n");
		expect(lines.slice(0, 3)).toEqual(["ENOENT: missing", "", "[hint] line one"]);
		// Canonical trailer format: `… +N hint lines (<key> to expand)`. The key
		// text depends on the keybindings registry (not initialized here), so assert
		// the counter + noun + affordance, not the literal shortcut.
		const trailer = stripAnsi(lines[3]);
		expect(trailer).toContain("… +2 hint lines (");
		expect(trailer).toContain("to expand)");
		expect(trailer).not.toContain("more lines");
	});

	test("collapses repair blocks with the default prefixes", () => {
		const input = "failed\n\n[repair] note one\n[repair] note two";
		const out = collapseAnnotatedBlocks(input, { expanded: false, muted, expandHint });
		const lines = out.split("\n");
		expect(lines.slice(0, 3)).toEqual(["failed", "", "[repair] note one"]);
		expect(stripAnsi(lines[3])).toContain("… +1 hint lines (");
	});

	test("preserves lines after the annotated block", () => {
		const input = "Error\n\n[hint] a\n[hint] b\nfooter";
		const out = collapseAnnotatedBlocks(input, { expanded: false, muted, expandHint });
		const lines = out.split("\n");
		expect(stripAnsi(lines[3])).toContain("… +1 hint lines (");
		expect(lines[4]).toBe("footer");
	});
});
