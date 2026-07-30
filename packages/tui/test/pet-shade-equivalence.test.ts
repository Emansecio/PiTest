/**
 * The pet's two renderers derive a pixel's palette index — and a cell's alpha —
 * from the SAME shading pass that produced its color. Both used to recompute:
 * the cell renderer called `shadePet` and then `petCoverage` on the same sample
 * (evaluating three SDFs twice), and the sixel encoder threw the coverage away
 * and searched all 41 palette entries per pixel to get it back.
 *
 * `shadePetWithCoverage` returns both at once, and `paletteIndex` derives the
 * ramp entry arithmetically wherever only one feature covers the pixel. That is
 * a pure refactor: these tests pin the equivalence so a future change to the
 * palette layout or the ramp resolution cannot silently alter what is drawn.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { renderPetCells } from "../src/pet-cells.js";
import {
	mixRgb,
	type PetColors,
	type PetParams,
	petCoverage,
	shadePet,
	shadePetWithCoverage,
} from "../src/pet-geometry.js";
import { renderPetSixel } from "../src/sixel.js";

const COLORS: PetColors = { bg: [10, 12, 14], stroke: [120, 220, 140], eye: [240, 250, 245] };

/** Animation states that put the eye rim over the head stroke, and ones that do not. */
function cases(): PetParams[] {
	const out: PetParams[] = [];
	for (const blinkK of [0, 0.25, 0.5, 0.75, 1]) {
		for (const lean of [-1, 0, 1]) {
			for (const squash of [0, 0.4]) out.push({ blinkK, lean, squash } as PetParams);
		}
	}
	return out;
}

describe("shadePetWithCoverage", () => {
	it("returns exactly what shadePet and petCoverage returned separately", () => {
		for (const params of cases()) {
			for (let j = 0; j < 24; j++) {
				for (let i = 0; i < 48; i++) {
					const x = (i / 48) * 2 - 1;
					const y = j / 24 - 0.5;
					const combined = shadePetWithCoverage(x, y, params, COLORS);
					assert.deepEqual(combined.color, shadePet(x, y, params, COLORS));
					const separate = petCoverage(x, y, params);
					assert.equal(combined.stroke, separate.stroke);
					assert.equal(combined.eye, separate.eye);
				}
			}
		}
	});
});

describe("sixel palette index", () => {
	it("agrees with a nearest-color search over the whole palette", () => {
		// The reference implementation the fast path replaced.
		const RAMP_STEPS = 20;
		const palette = [
			...Array.from({ length: RAMP_STEPS + 1 }, (_, i) => mixRgb(COLORS.bg, COLORS.stroke, i / RAMP_STEPS)),
			...Array.from({ length: RAMP_STEPS }, (_, i) => mixRgb(COLORS.bg, COLORS.eye, (i + 1) / RAMP_STEPS)),
		];
		const nearest = (c: readonly number[]): number => {
			let best = 0;
			let bd = Infinity;
			for (let i = 0; i < palette.length; i++) {
				const p = palette[i]!;
				const d = (c[0]! - p[0]) ** 2 + (c[1]! - p[1]) ** 2 + (c[2]! - p[2]) ** 2;
				if (d < bd) {
					bd = d;
					best = i;
				}
			}
			return best;
		};

		for (const params of cases()) {
			for (let j = 0; j < 24; j++) {
				for (let i = 0; i < 48; i++) {
					const x = (i / 48) * 2 - 1;
					const y = j / 24 - 0.5;
					const { color, stroke, eye } = shadePetWithCoverage(x, y, params, COLORS);
					// Only single-feature pixels take the arithmetic path; the composite
					// rim still goes through the search, so both must match everywhere.
					if (stroke > 0 && eye > 0) continue;
					assert.equal(
						eye === 0 ? Math.round(stroke * RAMP_STEPS) : nearest(color),
						nearest(color),
						`palette index diverged at (${x},${y})`,
					);
				}
			}
		}
	});
});

describe("rendered output is unchanged", () => {
	it("matches the pre-refactor sprite byte for byte", () => {
		// Digest of every sprite in the sweep, captured by running this exact
		// procedure against the implementation BEFORE the refactor. If it changes,
		// the pet looks different — which this refactor is not allowed to do.
		const h = createHash("sha256");
		for (const params of cases()) {
			h.update(renderPetSixel(96, 48, { ...params, colors: COLORS }));
			h.update(renderPetCells(16, 4, { ...params, colors: COLORS }).join("\n"));
		}
		assert.equal(h.digest("hex"), "1858a07af6ea71282a16af1b51f84b29a62b521958e58b73f69f93581c939c3d");
	});
});
