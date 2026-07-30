/**
 * SideBySide: two components sharing one band, and every way it stands down.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { SideBySide } from "../src/components/side-by-side.js";
import { SIXEL_INTRO } from "../src/sixel.js";
import type { Component } from "../src/tui.js";
import { visibleWidth } from "../src/utils.js";

function stub(lines: string[]): Component {
	return { render: () => lines, invalidate: () => {} };
}

const OPTS = { rightWidth: 10, gap: 2, minWidth: 40 };

/** Visible column where the rail text starts (ANSI-aware). */
function railColumn(line: string): number {
	return visibleWidth(line.slice(0, line.indexOf("rail")));
}

describe("SideBySide", () => {
	it("lays both columns on the same rows, the rail starting at its reserved column", () => {
		const s = new SideBySide(stub(["main a", "main b"]), stub(["rail a", "rail b"]), OPTS);
		const lines = s.render(40);
		assert.equal(lines.length, 2);
		for (const line of lines) {
			// Never wider than the viewport; a short rail row just ends early rather
			// than being padded to the edge (trailing spaces buy nothing).
			assert.ok(visibleWidth(line) <= 40, `line wider than the viewport: ${visibleWidth(line)}`);
			// Rail starts at the reserved column (width - rightWidth = 30). Measured in
			// COLUMNS, not string index — truncation injects ANSI resets.
			assert.equal(railColumn(line), 30, line);
		}
		assert.ok(lines[0].startsWith("main a"), lines[0]);
	});

	it("pads the shorter column so the band is as tall as the taller one", () => {
		const s = new SideBySide(stub(["only main"]), stub(["r1", "r2", "r3"]), OPTS);
		const lines = s.render(40);
		assert.equal(lines.length, 3);
		assert.ok(lines[2].trimStart().startsWith("r3"), lines[2]);
	});

	it("gives the full width back to the main column when the right renders nothing", () => {
		const main = stub(["all mine"]);
		const s = new SideBySide(main, stub([]), OPTS);
		assert.deepEqual(s.render(40), ["all mine"]);
	});

	it("stands down below minWidth", () => {
		const s = new SideBySide(stub(["narrow"]), stub(["rail"]), OPTS);
		assert.deepEqual(s.render(39), ["narrow"]);
	});

	it("stands down when disabled", () => {
		const s = new SideBySide(stub(["off"]), stub(["rail"]), { ...OPTS, enabled: () => false });
		assert.deepEqual(s.render(80), ["off"]);
	});

	it("leaves a sixel row untouched and resumes the rail below it", () => {
		const image = `${SIXEL_INTRO}0;1;0q"1;1;4;4\x1b\\`;
		const s = new SideBySide(stub(["text", image, "text"]), stub(["r1", "r2", "r3"]), OPTS);
		const lines = s.render(40);
		// The image line is emitted verbatim — no padding, no concatenation.
		assert.equal(lines[1], image);
		assert.ok(lines[0].endsWith("r1"));
		assert.ok(lines[2].endsWith("r3"));
	});

	it("drops the rail on a row where the RAIL paints an image (never concatenates a sixel)", () => {
		const image = `${SIXEL_INTRO}0;1;0q"1;1;4;4\x1b\\`;
		// truncateToWidth does not recognize the DCS wrapper — clipping a rail sixel
		// would emit a malformed sequence (desync the terminal parser, leak payload
		// bytes as text) or anchor it at the wrong column. The rail stands down for
		// that row, symmetric with an image in the main column.
		const s = new SideBySide(stub(["text a", "text b", "text c"]), stub(["r1", image, "r3"]), OPTS);
		const lines = s.render(40);
		assert.equal(lines[0].endsWith("r1"), true);
		assert.equal(lines[1], "text b"); // no rail, no DCS fragment concatenated
		assert.equal(lines[2].endsWith("r3"), true);
	});

	it("truncates an over-long main row instead of pushing the rail off screen", () => {
		const s = new SideBySide(stub(["x".repeat(200)]), stub(["rail"]), OPTS);
		const line = s.render(40)[0];
		assert.ok(visibleWidth(line) <= 40, `line wider than the viewport: ${visibleWidth(line)}`);
		assert.ok(line.endsWith("rail"), line);
		assert.equal(railColumn(line), 30, line);
	});
});
