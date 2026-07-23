import { stripVTControlCharacters } from "node:util";
import { type Component, type PetColors, Text, visibleWidth } from "@pit/tui";
import { describe, expect, test } from "vitest";
import { ComposerChrome } from "../src/modes/interactive/components/composer-chrome.ts";
import {
	createPetCompanion,
	PET_COMPANION_FOOTPRINT,
	PET_COMPANION_MIN_COLS,
} from "../src/modes/interactive/components/pet-companion.ts";

function plain(lines: string[]): string[] {
	return lines.map((line) => stripVTControlCharacters(line));
}

const PET_COLORS: PetColors = { bg: [10, 11, 14], stroke: [240, 240, 245], eye: [63, 224, 122] };

/** A single-line content stand-in for the editor that records the width it was
 * asked to render at, so we can assert the content narrows/recovers. */
class WidthProbe implements Component {
	lastWidth = -1;
	render(width: number): string[] {
		this.lastWidth = width;
		return ["input"];
	}
	invalidate(): void {}
}

function hasPetGlyph(lines: string[]): boolean {
	return lines.some((line) => line.includes("▀") || line.includes("▄"));
}

describe("ComposerChrome", () => {
	test("stacks the editor content and the footer flush-left, no boxed frame", () => {
		const composer = new ComposerChrome(new Text("message", 0, 0), new Text("workspace        model", 0, 0));
		const lines = plain(composer.render(30));

		// No frame glyphs anywhere — the composer is just content + footer.
		expect(lines.join("\n")).not.toMatch(/[╭╮╰╯│]/);
		expect(lines[0]).toBe(`message${" ".repeat(30 - "message".length)}`);
		expect(lines[1]).toBe("workspace        model");
		// The content row spans the full requested width; the footer strip is free
		// to be shorter (it's a status line, not a filled row).
		expect(visibleWidth(lines[0]!)).toBe(30);
		expect(visibleWidth(lines[1]!)).toBeLessThanOrEqual(30);
	});

	test("keeps multiline content and the footer at the requested width", () => {
		const composer = new ComposerChrome(new Text("first\nsecond", 0, 0), new Text("meta", 0, 0));
		const lines = plain(composer.render(10));

		// lines: first, second, footer — no top/bottom border rows.
		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("meta");
		for (const line of lines.slice(0, 2)) expect(visibleWidth(line)).toBe(10);
	});

	test("replaces footer content without replacing the composer", () => {
		const composer = new ComposerChrome(new Text("message", 0, 0), new Text("old", 0, 0));
		expect(plain(composer.render(20)).join("\n")).toContain("old");

		composer.setFooter(new Text("new", 0, 0));
		expect(plain(composer.render(20)).join("\n")).not.toContain("old");
		expect(plain(composer.render(20)).join("\n")).toContain("new");
	});
});

describe("ComposerChrome pet gutter", () => {
	function build(visiblePredicate = (w: number) => w >= PET_COMPANION_MIN_COLS) {
		const content = new WidthProbe();
		const footer = new Text("workspace · model · tokens", 0, 0);
		const composer = new ComposerChrome(content, footer);
		const pet = createPetCompanion({ getColors: () => PET_COLORS });
		composer.setRightGutter(pet, PET_COMPANION_FOOTPRINT, visiblePredicate);
		return { composer, content };
	}

	test("perches the pet beside the editor and narrows the content at cols=120", () => {
		const { composer, content } = build();
		const raw = composer.render(120);
		const lines = plain(raw);
		// The pet renders (half-block glyphs) on the content rows.
		expect(hasPetGlyph(lines.slice(0, -1))).toBe(true);
		// The content gave up exactly the pet footprint — no border columns reserved.
		expect(content.lastWidth).toBe(120 - PET_COMPANION_FOOTPRINT);
		// Every content row still spans the full terminal width (content + gutter).
		for (const line of lines.slice(0, -1)) expect(visibleWidth(line)).toBe(120);
		// The footer keeps the FULL width — the pet only borrows from the content.
		expect(visibleWidth(lines.at(-1)!)).toBeLessThanOrEqual(120);
	});

	test("hides the pet and restores full editor width at cols=80", () => {
		const { composer, content } = build();
		const lines = plain(composer.render(80));
		expect(hasPetGlyph(lines)).toBe(false);
		// Content reclaims the whole width — no border columns to give back either.
		expect(content.lastWidth).toBe(80);
		expect(visibleWidth(lines[0]!)).toBe(80);
	});

	test("cedes to a modal: the visibility predicate can hide the pet even when wide", () => {
		let modalOpen = false;
		const { composer, content } = build((w) => w >= PET_COMPANION_MIN_COLS && !modalOpen);
		expect(hasPetGlyph(plain(composer.render(120)).slice(0, -1))).toBe(true);
		modalOpen = true;
		const hidden = plain(composer.render(120));
		expect(hasPetGlyph(hidden)).toBe(false);
		// Editor recovers the full content width while the pet is ceded.
		expect(content.lastWidth).toBe(120);
	});

	test("clearing the gutter restores the plain composer", () => {
		const { composer, content } = build();
		composer.render(120);
		expect(content.lastWidth).toBe(120 - PET_COMPANION_FOOTPRINT);
		composer.setRightGutter(undefined);
		expect(hasPetGlyph(plain(composer.render(120)))).toBe(false);
		expect(content.lastWidth).toBe(120);
	});
});
