/**
 * Tests for the pet: pure geometry, the sixel encoder, the cell fallback, and
 * sixel-support detection.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { renderPetCells } from "../src/pet-cells.js";
import { mixRgb, type PetColors, petCoverage, shadePet, toLocalPoint } from "../src/pet-geometry.js";
import { encodeSixel, renderPetSixel, SIXEL_INTRO } from "../src/sixel.js";
import {
	getSixelSupport,
	isSixelForcedOff,
	parseSixelDeviceAttributes,
	resetSixelSupport,
	setSixelSupport,
} from "../src/terminal-image.js";
import { visibleWidth } from "../src/utils.js";

const COLORS: PetColors = {
	bg: [10, 11, 14],
	stroke: [240, 240, 245],
	eye: [63, 224, 122],
};

describe("pet-geometry", () => {
	it("mixRgb blends linearly per channel", () => {
		assert.deepEqual(mixRgb([0, 0, 0], [100, 200, 40], 0), [0, 0, 0]);
		assert.deepEqual(mixRgb([0, 0, 0], [100, 200, 40], 1), [100, 200, 40]);
		assert.deepEqual(mixRgb([0, 0, 0], [100, 200, 40], 0.5), [50, 100, 20]);
	});

	it("is fully background far outside the head", () => {
		const cov = petCoverage(0.99, 0.49, { blinkK: 1 });
		assert.equal(cov.stroke, 0);
		assert.equal(cov.eye, 0);
		assert.deepEqual(shadePet(0.99, 0.49, { blinkK: 1 }, COLORS), COLORS.bg);
	});

	it("covers the stroke ring near the head edge", () => {
		// Top edge of the rounded box is near y = -0.33 at x = 0.
		const cov = petCoverage(0, -0.33, { blinkK: 1 });
		assert.ok(cov.stroke > 0.5, `expected stroke coverage on the ring, got ${cov.stroke}`);
	});

	it("fills the eyes when open and collapses them on blink", () => {
		// Left eye center is at x = -0.24, y = -0.02.
		const open = petCoverage(-0.24, -0.02, { blinkK: 1 });
		assert.ok(open.eye > 0.5, `expected open eye coverage, got ${open.eye}`);
		const blink = petCoverage(-0.24, -0.28, { blinkK: 1 });
		// A point well above the eye center is only covered when the eye is open;
		// verify the squint removes coverage there.
		const openHigh = petCoverage(-0.24, -0.13, { blinkK: 1 });
		const blinkHigh = petCoverage(-0.24, -0.13, { blinkK: 0.08 });
		assert.ok(openHigh.eye > blinkHigh.eye, "blink should shrink vertical eye coverage");
		void blink;
	});

	it("eyeShift moves the eyes horizontally", () => {
		const centered = petCoverage(-0.24, -0.02, { blinkK: 1, eyeShift: 0 });
		const shifted = petCoverage(-0.24, -0.02, { blinkK: 1, eyeShift: 0.1 });
		assert.notEqual(centered.eye, shifted.eye);
	});

	it("eyeShiftY moves the eyes vertically and eyeScale resizes them", () => {
		const centered = petCoverage(-0.24, -0.02, { blinkK: 1 });
		// A point below the eye is only covered once the gaze drops.
		const below = { x: -0.24, y: 0.22 };
		assert.ok(petCoverage(below.x, below.y, { blinkK: 1 }).eye < 0.5, "point starts outside the eye");
		assert.ok(
			petCoverage(below.x, below.y, { blinkK: 1, eyeShiftY: 0.15 }).eye > 0.5,
			"looking down should cover the point below",
		);
		// Widening the eye covers a point the resting eye misses.
		assert.ok(petCoverage(-0.24, -0.14, { blinkK: 1 }).eye < 0.5);
		assert.ok(petCoverage(-0.24, -0.14, { blinkK: 1, eyeScale: 1.5 }).eye > 0.5);
		assert.equal(centered.eye, petCoverage(-0.24, -0.02, { blinkK: 1, eyeScale: 1 }).eye);
	});

	it("toLocalPoint inverts the body transform", () => {
		// Translation: a bob down moves the sample point up in the pet's frame.
		assert.deepEqual(toLocalPoint(0, 0, { blinkK: 1, bobY: 0.1 }), { x: 0, y: -0.1 });
		assert.deepEqual(toLocalPoint(0.2, 0, { blinkK: 1, bobX: 0.2 }), { x: 0, y: 0 });
		// Rotation: a quarter turn maps +x onto -y.
		const rotated = toLocalPoint(1, 0, { blinkK: 1, tilt: Math.PI / 2 });
		assert.ok(Math.abs(rotated.x) < 1e-9, `expected x≈0, got ${rotated.x}`);
		assert.ok(Math.abs(rotated.y + 1) < 1e-9, `expected y≈-1, got ${rotated.y}`);
		// Squash widens x and shortens y — the inverse divides by those factors.
		const squashed = toLocalPoint(0.5, 0.5, { blinkK: 1, squash: 0.25 });
		assert.ok(squashed.x < 0.5 && squashed.y > 0.5);
		// Beyond the clamp the transform stops growing (the shape can never invert).
		assert.deepEqual(
			toLocalPoint(0.5, 0.5, { blinkK: 1, squash: 5 }),
			toLocalPoint(0.5, 0.5, { blinkK: 1, squash: 0.45 }),
		);
	});

	it("the body transform moves the silhouette without redrawing it", () => {
		// The head's top edge at rest…
		const edge = { x: 0, y: -0.33 };
		assert.ok(petCoverage(edge.x, edge.y, { blinkK: 1 }).stroke > 0.5);
		// …is no longer at that point once the body lifts, but is found 0.1 higher.
		const lifted = { blinkK: 1, bobY: -0.1 };
		assert.ok(petCoverage(edge.x, edge.y, lifted).stroke < 0.5, "edge should have moved away");
		assert.ok(petCoverage(edge.x, edge.y - 0.1, lifted).stroke > 0.5, "edge should be found at the new height");
	});

	it("is deterministic", () => {
		const a = shadePet(0.1, 0.05, { blinkK: 1 }, COLORS);
		const b = shadePet(0.1, 0.05, { blinkK: 1 }, COLORS);
		assert.deepEqual(a, b);
	});
});

describe("encodeSixel", () => {
	it("emits the P2=1 transparent preamble and ST terminator", () => {
		const idx = new Uint8Array(2 * 6); // one band, all index 0
		const out = encodeSixel(2, 6, idx, [[0, 0, 0]]);
		assert.ok(out.startsWith(`${SIXEL_INTRO}0;1;0q`), "expected sixel intro with P2=1");
		assert.ok(out.includes('"1;1;2;6'), "expected raster attributes");
		assert.ok(out.endsWith("\x1b\\"), "expected string terminator");
	});

	it("registers palette colors as 0-100 percentages", () => {
		const idx = new Uint8Array(1 * 6);
		idx.fill(1);
		const out = encodeSixel(1, 6, idx, [
			[0, 0, 0],
			[255, 0, 0],
		]);
		assert.ok(out.includes("#0;2;0;0;0"), "index 0 = black");
		assert.ok(out.includes("#1;2;100;0;0"), "index 1 = full red");
	});

	it("run-length encodes long runs with !count", () => {
		const idx = new Uint8Array(10 * 6);
		idx.fill(1); // full row of index 1 across 10 columns
		const out = encodeSixel(10, 6, idx, [
			[0, 0, 0],
			[255, 255, 255],
		]);
		assert.ok(/!10/.test(out), `expected RLE !10 in ${JSON.stringify(out)}`);
	});

	it("omits transparent indices entirely", () => {
		// Column 0 = index 1 (opaque), column 1 = index 2 (transparent).
		const idx = new Uint8Array(2 * 6);
		for (let j = 0; j < 6; j++) {
			idx[j * 2 + 0] = 1;
			idx[j * 2 + 1] = 2;
		}
		const out = encodeSixel(
			2,
			2 * 3,
			idx,
			[
				[0, 0, 0],
				[255, 255, 255],
				[1, 1, 1],
			],
			{
				transparent: new Set([2]),
			},
		);
		// Color 1 is drawn; color 2 (transparent) never gets a `#2` data run.
		assert.ok(out.includes("#1"), "opaque color present");
		assert.ok(!/#2[?~!A-Za-z]/.test(out.replace("#2;2;", "")), "transparent color has no pixel data");
	});

	/**
	 * The band separator is a graphics NEW-LINE: one after the last band opens a
	 * sixth empty band, and a terminal that sizes the image by its content rather
	 * than by the raster attributes hands those 6 px back as extra height. On a
	 * sprite authored in whole terminal rows that lone band is the difference
	 * between fitting its reservation and drawing into the row below it.
	 */
	it("separates bands without a trailing graphics new-line", () => {
		const idx = new Uint8Array(1 * 18); // exactly three 6-row bands
		idx.fill(1);
		const out = encodeSixel(1, 18, idx, [
			[0, 0, 0],
			[255, 255, 255],
		]);
		const data = out.slice(0, -2); // drop the ST
		assert.equal((data.match(/-/g) ?? []).length, 2, "three bands need two separators");
		assert.ok(!data.endsWith("-"), "no graphics new-line after the final band");
	});

	it("emits no separator at all for a single band", () => {
		const idx = new Uint8Array(1 * 6);
		idx.fill(1);
		const out = encodeSixel(1, 6, idx, [
			[0, 0, 0],
			[255, 255, 255],
		]);
		assert.ok(!out.includes("-"), `single band needs no separator: ${JSON.stringify(out)}`);
	});
});

describe("renderPetSixel", () => {
	it("produces a valid transparent sixel for the pet", () => {
		const out = renderPetSixel(60, 30, { blinkK: 1, colors: COLORS });
		assert.ok(out.startsWith(`${SIXEL_INTRO}0;1;0q`));
		assert.ok(out.includes('"1;1;60;30'));
		assert.ok(out.endsWith("\x1b\\"));
	});

	it("is deterministic for the same params", () => {
		const a = renderPetSixel(40, 20, { blinkK: 1, colors: COLORS });
		const b = renderPetSixel(40, 20, { blinkK: 1, colors: COLORS });
		assert.equal(a, b);
	});

	it("changes when blinkK changes", () => {
		const open = renderPetSixel(40, 20, { blinkK: 1, colors: COLORS });
		const blink = renderPetSixel(40, 20, { blinkK: 0.08, colors: COLORS });
		assert.notEqual(open, blink);
	});

	it("forwards the body channels to the shader", () => {
		const rest = renderPetSixel(60, 30, { blinkK: 1, colors: COLORS });
		for (const moved of [{ bobY: 0.08 }, { bobX: 0.08 }, { tilt: 0.2 }, { squash: 0.2 }]) {
			assert.notEqual(renderPetSixel(60, 30, { blinkK: 1, colors: COLORS, ...moved }), rest, JSON.stringify(moved));
		}
	});
});

describe("renderPetCells", () => {
	it("returns exactly `rows` lines, each `cols` wide", () => {
		const lines = renderPetCells(30, 8, { blinkK: 1, colors: COLORS });
		assert.equal(lines.length, 8);
		for (const line of lines) {
			assert.equal(visibleWidth(line), 30, `line width should equal cols: ${JSON.stringify(line)}`);
		}
	});

	it("draws half-block glyphs for the pet body", () => {
		const joined = renderPetCells(30, 8, { blinkK: 1, colors: COLORS }).join("\n");
		assert.ok(joined.includes("▀") || joined.includes("▄"), "expected half-block glyphs");
		assert.ok(joined.includes("\x1b[38;2;"), "expected truecolor fg");
	});

	it("is deterministic", () => {
		const a = renderPetCells(24, 6, { blinkK: 1, colors: COLORS });
		const b = renderPetCells(24, 6, { blinkK: 1, colors: COLORS });
		assert.deepEqual(a, b);
	});

	it("forwards the body channels to the shader", () => {
		const rest = renderPetCells(24, 6, { blinkK: 1, colors: COLORS });
		const lifted = renderPetCells(24, 6, { blinkK: 1, colors: COLORS, bobY: -0.1 });
		assert.notDeepEqual(lifted, rest);
	});
});

describe("sixel detection", () => {
	afterEach(() => {
		resetSixelSupport();
		delete process.env.PIT_NO_SIXEL;
	});

	it("parses the DA1 sixel attribute (4)", () => {
		assert.equal(parseSixelDeviceAttributes("\x1b[?62;4;6c"), true);
		assert.equal(parseSixelDeviceAttributes("\x1b[?64;1;2;4;6;9;15;22c"), true);
	});

	it("reports no sixel when attribute 4 is absent", () => {
		assert.equal(parseSixelDeviceAttributes("\x1b[?62;6c"), false);
		assert.equal(parseSixelDeviceAttributes("\x1b[?1;2c"), false);
	});

	it("returns undefined for non-DA1 input (keystrokes fall through)", () => {
		assert.equal(parseSixelDeviceAttributes("a"), undefined);
		assert.equal(parseSixelDeviceAttributes("\x1b[6;18;9t"), undefined);
	});

	it("setSixelSupport becomes authoritative", () => {
		setSixelSupport(true);
		assert.equal(getSixelSupport(), true);
		setSixelSupport(false);
		assert.equal(getSixelSupport(), false);
	});

	it("PIT_NO_SIXEL forces the cell fallback", () => {
		setSixelSupport(true);
		process.env.PIT_NO_SIXEL = "1";
		assert.equal(isSixelForcedOff(), true);
		assert.equal(getSixelSupport(), false);
	});
});
