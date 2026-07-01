import { describe, expect, test } from "vitest";
import { collapseAnnotatedBlocks } from "../src/modes/interactive/components/annotated-block-collapse.js";

const muted = (s: string) => `[muted:${s}]`;
const expandHint = "ctrl+o to expand";

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
		expect(out).toBe(`ENOENT: missing\n\n[hint] line one\n[muted:… (2 hint lines, ${expandHint})]`);
	});

	test("collapses repair blocks with the default prefixes", () => {
		const input = "failed\n\n[repair] note one\n[repair] note two";
		const out = collapseAnnotatedBlocks(input, { expanded: false, muted, expandHint });
		expect(out).toBe(`failed\n\n[repair] note one\n[muted:… (1 hint lines, ${expandHint})]`);
	});

	test("preserves lines after the annotated block", () => {
		const input = "Error\n\n[hint] a\n[hint] b\nfooter";
		const out = collapseAnnotatedBlocks(input, { expanded: false, muted, expandHint });
		expect(out).toBe(`Error\n\n[hint] a\n[muted:… (1 hint lines, ${expandHint})]\nfooter`);
	});
});
