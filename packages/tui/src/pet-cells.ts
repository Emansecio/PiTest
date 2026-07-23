/**
 * Pet cell renderer — the universal fallback for terminals without sixel.
 *
 * Draws the mascot ({@link ./pet-geometry.ts}) with half-block characters: each
 * character cell stacks two vertical pixels — the upper half (`▀`, foreground)
 * and the lower half (background). Colors are supersampled (3×3 by default) and
 * anti-aliased against an injected background so edges stay smooth.
 *
 * Fully-background cells emit a plain space (no color), and a cell with only one
 * pet half uses a one-sided half-block so the empty half falls through to the
 * terminal's own background — that keeps the pet from painting an opaque
 * rectangle around itself.
 */

import { type PetColors, type PetParams, petCoverage, type Rgb, shadePet } from "./pet-geometry.ts";

export interface RenderPetCellsOptions extends PetParams {
	colors: PetColors;
	/** Samples per axis per pixel (3 → 3×3 = 9 samples). Default 3. */
	supersample?: number;
}

const UPPER_HALF = "▀";
const LOWER_HALF = "▄";
const RESET = "\x1b[0m";
/** Below this combined coverage a pixel counts as background (transparent). */
const BG_THRESHOLD = 0.04;

function fg(c: Rgb): string {
	return `\x1b[38;2;${Math.round(c[0])};${Math.round(c[1])};${Math.round(c[2])}m`;
}
function bg(c: Rgb): string {
	return `\x1b[48;2;${Math.round(c[0])};${Math.round(c[1])};${Math.round(c[2])}m`;
}

/** Supersampled coverage + blended color for one output pixel. */
function samplePixel(
	i: number,
	j: number,
	W: number,
	H: number,
	ss: number,
	params: PetParams,
	colors: PetColors,
): { alpha: number; color: Rgb } {
	let r = 0;
	let g = 0;
	let b = 0;
	let alpha = 0;
	const n = ss * ss;
	for (let sy = 0; sy < ss; sy++) {
		for (let sx = 0; sx < ss; sx++) {
			const x = ((i + (sx + 0.5) / ss) / W) * 2 - 1;
			const y = (j + (sy + 0.5) / ss) / H - 0.5;
			const c = shadePet(x, y, params, colors);
			r += c[0];
			g += c[1];
			b += c[2];
			const cov = petCoverage(x, y, params);
			alpha += Math.max(cov.stroke, cov.eye);
		}
	}
	return { alpha: alpha / n, color: [r / n, g / n, b / n] };
}

/**
 * Render the pet into `rows` lines of `cols` half-block cells. Vertical
 * resolution is `rows * 2` pixels; horizontal is `cols` pixels. Every returned
 * line has an exact visible width of `cols`.
 */
export function renderPetCells(cols: number, rows: number, options: RenderPetCellsOptions): string[] {
	const W = Math.max(1, Math.floor(cols));
	const rowCount = Math.max(1, Math.floor(rows));
	const H = rowCount * 2;
	const ss = Math.max(1, Math.floor(options.supersample ?? 3));
	const params: PetParams = { blinkK: options.blinkK, eyeShift: options.eyeShift };
	const colors = options.colors;

	const lines: string[] = [];
	for (let row = 0; row < rowCount; row++) {
		let line = "";
		for (let i = 0; i < W; i++) {
			const top = samplePixel(i, row * 2, W, H, ss, params, colors);
			const bot = samplePixel(i, row * 2 + 1, W, H, ss, params, colors);
			const topBg = top.alpha < BG_THRESHOLD;
			const botBg = bot.alpha < BG_THRESHOLD;
			if (topBg && botBg) {
				line += " ";
			} else if (botBg) {
				// Only the upper half is pet — lower half falls through to terminal bg.
				line += `${fg(top.color)}${UPPER_HALF}${RESET}`;
			} else if (topBg) {
				// Only the lower half is pet.
				line += `${fg(bot.color)}${LOWER_HALF}${RESET}`;
			} else {
				// Both halves pet: upper = fg, lower = bg of an upper-half block.
				line += `${fg(top.color)}${bg(bot.color)}${UPPER_HALF}${RESET}`;
			}
		}
		lines.push(line);
	}
	return lines;
}
