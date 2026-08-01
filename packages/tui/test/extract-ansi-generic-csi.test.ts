import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractAnsiCode, visibleWidth } from "../src/utils.js";

// extractAnsiCode's CSI branch historically only recognized the terminators
// m/G/K/H/J; any other final byte made the whole sequence "not ANSI" and its
// body counted as visible text — corrupting width math (and thus truncation)
// for strings carrying cursor-visibility, cursor-movement, or cursor-style
// sequences. The branch now accepts the full ECMA-48 grammar:
// ESC [ <params 0x30–0x3F> <intermediates 0x20–0x2F> <final 0x40–0x7E>.
describe("extractAnsiCode generic CSI terminators", () => {
	it("treats DECTCEM / CUU / DECSCUSR sequences as zero-width", () => {
		assert.equal(visibleWidth("\x1b[?25lfoo"), 3);
		assert.equal(visibleWidth("\x1b[2Afoo"), 3);
		assert.equal(visibleWidth("\x1b[4 qfoo"), 3);
	});

	it("extracts the full sequence for non-SGR final bytes", () => {
		assert.deepEqual(extractAnsiCode("\x1b[?25l", 0), { code: "\x1b[?25l", length: 6 });
		assert.deepEqual(extractAnsiCode("\x1b[2A", 0), { code: "\x1b[2A", length: 4 });
		assert.deepEqual(extractAnsiCode("\x1b[4 q", 0), { code: "\x1b[4 q", length: 5 });
		assert.deepEqual(extractAnsiCode("\x1b[12;34H", 0), { code: "\x1b[12;34H", length: 8 });
	});

	it("still extracts classic SGR/erase sequences", () => {
		assert.deepEqual(extractAnsiCode("\x1b[31m", 0), { code: "\x1b[31m", length: 5 });
		assert.deepEqual(extractAnsiCode("\x1b[2K", 0), { code: "\x1b[2K", length: 4 });
		assert.equal(visibleWidth("\x1b[31mfoo\x1b[0m"), 3);
		assert.equal(visibleWidth("\x1b[38;5;196mred\x1b[0m"), 3);
	});

	it("returns null for a truncated CSI (no final byte before end of string)", () => {
		assert.equal(extractAnsiCode("\x1b[", 0), null);
		assert.equal(extractAnsiCode("\x1b[?25", 0), null);
		assert.equal(extractAnsiCode("\x1b[38;5;", 0), null);
		assert.equal(extractAnsiCode("\x1b[4 ", 0), null);
		// A truncated trailing CSI keeps the historical fallback: the ESC is
		// skipped, the remaining body counts as visible text.
		assert.equal(visibleWidth("foo\x1b["), 4);
		assert.equal(visibleWidth("foo\x1b[?25"), 7);
	});

	it("does not swallow text after a complete sequence", () => {
		// Params stop at the first byte outside the CSI grammar's ranges, so the
		// sequence ends at its real final byte and ordinary text survives.
		assert.equal(visibleWidth("\x1b[?25lstatus ok"), 9);
		const ansi = extractAnsiCode("\x1b[1mbold", 0);
		assert.deepEqual(ansi, { code: "\x1b[1m", length: 4 });
	});
});
