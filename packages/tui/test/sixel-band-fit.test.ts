/**
 * The sprite must never draw past the rows it reserved.
 *
 * A sixel states its height twice: exactly, in the raster attributes, and
 * implicitly, as a count of 6-pixel bands. Terminals disagree about which one
 * decides the image's footprint, and the disagreement is invisible until the
 * drawing lands on the bottom row of the screen — there the extra pixels make the
 * terminal scroll, every row index the differential renderer tracks shifts by one,
 * and each repaint of a live line (the spinner, the elapsed clock) prints one row
 * lower than the last. That is the stacked-"Thinking…" corruption.
 *
 * `fitSixelHeightPx` removes the disagreement by only ever asking for whole bands,
 * so both readings of the height are the same number. These tests pin that down
 * across every cell size a real terminal might report, measuring the bands the
 * encoder ACTUALLY emitted rather than trusting the requested height.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitSixelHeightPx, renderPetSixel, SIXEL_BAND_HEIGHT } from "../src/sixel.js";

/**
 * Bands the encoder actually advanced through, counted from the payload.
 *
 * The graphics-newline `-` separates bands and appears nowhere else: sixel data
 * bytes are `?`–`~` (63–126), run lengths are `!<digits>`, and color registers are
 * `#i;2;r;g;b`. So bands = separators + 1. This is a LOWER bound on the footprint —
 * the encoder holds back separators that would not position any pixels, so a sprite
 * whose bottom band is transparent advances fewer bands than it declares.
 */
function advancedBands(sixel: string): number {
	let separators = 0;
	for (const ch of sixel) if (ch === "-") separators++;
	return separators + 1;
}

/** The `H` the encoder declared in its raster attributes (`"1;1;W;H`). */
function declaredHeightPx(sixel: string): number {
	const match = sixel.match(/"1;1;\d+;(\d+)/);
	assert.ok(match, "raster attributes must be present");
	return Number(match[1]);
}

/**
 * The footprint a terminal reserves when it rounds an image up to whole bands —
 * the WORST case among the behaviors seen in the wild, and therefore the number
 * that has to fit inside the reservation.
 */
function bandRoundedPx(heightPx: number): number {
	return Math.ceil(heightPx / SIXEL_BAND_HEIGHT) * SIXEL_BAND_HEIGHT;
}

const COLORS = {
	bg: [0, 0, 0],
	stroke: [255, 255, 255],
	eye: [0, 255, 0],
} as const;

/** Cell heights a terminal might report, from tiny to HiDPI. */
const CELL_HEIGHTS = [6, 7, 8, 11, 13, 16, 17, 18, 19, 20, 23, 24, 29, 32, 37, 40, 48, 64];
/** Rows the two pets draw into: the composer perch and the startup hero. */
const DRAW_ROWS = [3, 5];

describe("fitSixelHeightPx", () => {
	it("returns whole bands only", () => {
		for (let px = 1; px <= 200; px++) {
			assert.equal(fitSixelHeightPx(px) % SIXEL_BAND_HEIGHT, 0, `${px}px must round to whole bands`);
		}
	});

	it("never exceeds the room it was given", () => {
		// One band is the floor, so the guarantee starts where a band fits at all.
		for (let px = SIXEL_BAND_HEIGHT; px <= 200; px++) {
			assert.ok(fitSixelHeightPx(px) <= px, `${px}px: ${fitSixelHeightPx(px)} overshoots`);
		}
	});

	it("takes the largest height that fits, not a smaller safe one", () => {
		assert.equal(fitSixelHeightPx(51), 48, "8.5 bands of room is 8 bands of sprite");
		assert.equal(fitSixelHeightPx(48), 48, "an exact fit is not shrunk");
		assert.equal(fitSixelHeightPx(53), 48);
		assert.equal(fitSixelHeightPx(54), 54, "the next whole band is taken as soon as it fits");
	});

	it("hands back one band rather than nothing when there is no room", () => {
		// Guarding the caller against a zero-height sprite; a cell this small is not
		// a real configuration (a measured cell is floored well above it).
		assert.equal(fitSixelHeightPx(0), SIXEL_BAND_HEIGHT);
		assert.equal(fitSixelHeightPx(5), SIXEL_BAND_HEIGHT);
	});
});

describe("the pet sprite fits its reserved rows", () => {
	it("fits every plausible cell size, on strict AND band-rounding terminals", () => {
		for (const rows of DRAW_ROWS) {
			for (const cellHeight of CELL_HEIGHTS) {
				const available = rows * cellHeight;
				const heightPx = fitSixelHeightPx(available);
				const sixel = renderPetSixel(heightPx * 2, heightPx, { blinkK: 1, colors: COLORS });
				const where = `${rows} rows × ${cellHeight}px`;

				// A terminal that honors the raster attributes exactly.
				const declared = declaredHeightPx(sixel);
				assert.ok(declared <= available, `${where}: declared ${declared}px into ${available}px`);
				// A terminal that rounds the image up to whole bands — the worst case.
				assert.ok(
					bandRoundedPx(declared) <= available,
					`${where}: band-rounded ${bandRoundedPx(declared)}px into ${available}px`,
				);
				// And what the payload actually walks through.
				const advanced = advancedBands(sixel) * SIXEL_BAND_HEIGHT;
				assert.ok(advanced <= available, `${where}: advanced ${advanced}px into ${available}px`);
			}
		}
	});

	it("would overflow without the quantization — the regression this guards", () => {
		// The reporter's shape: a 3-row perch on a 17px cell, so 51px of room. Asking
		// for all 51 fits the attributes exactly and STILL overflows, because 51px is
		// 8.5 bands and a band-rounding terminal reserves 9 of them — 54px, three
		// pixels into the row below.
		const available = 3 * 17;
		assert.equal(bandRoundedPx(51), 54);
		assert.ok(bandRoundedPx(51) > available, "the raw height really does overshoot");

		assert.equal(fitSixelHeightPx(available), 48);
		assert.ok(bandRoundedPx(48) <= available, "the fitted height stays inside the perch either way");
	});

	it("leaves no trailing band separator, which would cost a phantom band", () => {
		// The pet's silhouette floats, so its bottom band is transparent and emits
		// nothing — the separator that would have led into it must not be written.
		for (const heightPx of [48, 54, 60, 96]) {
			const body = renderPetSixel(heightPx * 2, heightPx, { blinkK: 1, colors: COLORS }).slice(0, -"\x1b\\".length);
			assert.ok(!body.endsWith("-"), `${heightPx}px: a trailing \`-\` advances into a row the sprite does not own`);
		}
	});
});
