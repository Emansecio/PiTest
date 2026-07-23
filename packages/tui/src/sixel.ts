/**
 * Sixel encoder — a small, generic DCS-sixel writer, plus {@link renderPetSixel}
 * which draws Pit's mascot ({@link ./pet-geometry.ts}) as a transparent sixel.
 *
 * Sixel packs six vertical pixels per character into a DCS string. This encoder
 * emits:
 *   - the intro `ESC P 0 ; 1 ; 0 q` — **P2 = 1** means "pixels not set stay at
 *     the cell's current color", i.e. transparent background (no opaque box),
 *   - raster attributes `"1;1;W;H`,
 *   - a color-registered palette (`#i;2;r;g;b`, percentages),
 *   - one 6-row band at a time, run-length encoded (`!count char`),
 *   - the string terminator `ESC \`.
 *
 * Only terminals that answer the DA1 query with the sixel attribute (`;4`) get
 * this path — see {@link ./terminal-image.ts}. Everything else falls back to
 * {@link ./pet-cells.ts}.
 */

import { mixRgb, type PetColors, type PetParams, type Rgb, shadePet } from "./pet-geometry.ts";

/** DCS introducer for a sixel image. `isImageLine()` keys off this substring so
 * the differential renderer leaves sixel lines untouched. */
export const SIXEL_INTRO = "\x1bP";

const ST = "\x1b\\";

function channelToPct(v: number): number {
	// Sixel color registers are 0–100 per channel.
	return Math.round((Math.max(0, Math.min(255, v)) / 255) * 100);
}

export interface EncodeSixelOptions {
	/** Palette indices to treat as transparent (never emitted). */
	transparent?: ReadonlySet<number>;
}

/**
 * Encode an indexed bitmap as a sixel DCS string.
 *
 * @param width  image width in pixels
 * @param height image height in pixels
 * @param indices `width * height` palette indices, row-major (`y * width + x`)
 * @param palette RGB entries; index `i` in `indices` refers to `palette[i]`
 */
export function encodeSixel(
	width: number,
	height: number,
	indices: Uint8Array,
	palette: readonly Rgb[],
	options: EncodeSixelOptions = {},
): string {
	const transparent = options.transparent ?? new Set<number>();
	let out = `${SIXEL_INTRO}0;1;0q"1;1;${width};${height}`;
	for (let i = 0; i < palette.length; i++) {
		const p = palette[i]!;
		out += `#${i};2;${channelToPct(p[0])};${channelToPct(p[1])};${channelToPct(p[2])}`;
	}

	const bandCount = Math.ceil(height / 6);
	for (let band = 0; band < bandCount; band++) {
		const y0 = band * 6;
		// Which colors actually appear in this band (skip a full palette sweep).
		const used = new Set<number>();
		for (let j = y0; j < Math.min(y0 + 6, height); j++) {
			for (let i = 0; i < width; i++) used.add(indices[j * width + i]!);
		}
		let first = true;
		for (const color of used) {
			if (transparent.has(color)) continue;
			if (!first) out += "$"; // carriage return within the band: overlay next color
			first = false;
			out += `#${color}`;
			let prev = -1;
			let count = 0;
			let run = "";
			const flush = () => {
				if (!count) return;
				const ch = String.fromCharCode(63 + prev);
				run += count > 3 ? `!${count}${ch}` : ch.repeat(count);
			};
			for (let i = 0; i < width; i++) {
				let bits = 0;
				for (let dy = 0; dy < 6; dy++) {
					const j = y0 + dy;
					if (j < height && indices[j * width + i] === color) bits |= 1 << dy;
				}
				if (bits === prev) count++;
				else {
					flush();
					prev = bits;
					count = 1;
				}
			}
			flush();
			out += run;
		}
		out += "-"; // graphics new-line: advance to the next 6-row band
	}

	return out + ST;
}

/** Ramp resolution per feature (bg→stroke, bg→eye). More steps = smoother AA. */
const RAMP_STEPS = 20;
// Palette layout: [0..RAMP_STEPS] = bg→stroke, [RAMP_STEPS+1 .. 2*RAMP_STEPS] =
// bg→eye. The two entries closest to bg on each ramp are treated as transparent
// so faint anti-alias fringes don't paint an opaque halo (the border-artifact
// fix from the approved mock).
const STROKE_BASE = 0;
const EYE_BASE = RAMP_STEPS + 1;
const FAINT_TRANSPARENT: ReadonlySet<number> = new Set([
	STROKE_BASE,
	STROKE_BASE + 1,
	STROKE_BASE + 2,
	EYE_BASE,
	EYE_BASE + 1,
]);

function buildPetPalette(colors: PetColors): Rgb[] {
	const palette: Rgb[] = [];
	for (let i = 0; i <= RAMP_STEPS; i++) palette.push(mixRgb(colors.bg, colors.stroke, i / RAMP_STEPS));
	for (let i = 1; i <= RAMP_STEPS; i++) palette.push(mixRgb(colors.bg, colors.eye, i / RAMP_STEPS));
	return palette;
}

function nearestIndex(c: Rgb, palette: readonly Rgb[]): number {
	let best = 0;
	let bd = Infinity;
	for (let i = 0; i < palette.length; i++) {
		const p = palette[i]!;
		const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
		if (d < bd) {
			bd = d;
			best = i;
		}
	}
	return best;
}

export interface RenderPetSixelOptions extends PetParams {
	colors: PetColors;
}

/**
 * Render the pet as a transparent sixel string, ready to write to a
 * sixel-capable terminal. `widthPx × heightPx` are device pixels (use the
 * terminal's reported cell size to map to a target cell footprint).
 */
export function renderPetSixel(widthPx: number, heightPx: number, options: RenderPetSixelOptions): string {
	const W = Math.max(1, Math.round(widthPx));
	const H = Math.max(1, Math.round(heightPx));
	const palette = buildPetPalette(options.colors);
	const params: PetParams = { blinkK: options.blinkK, eyeShift: options.eyeShift };
	const idx = new Uint8Array(W * H);
	for (let j = 0; j < H; j++) {
		for (let i = 0; i < W; i++) {
			const x = (i / W) * 2 - 1;
			const y = j / H - 0.5;
			const c = shadePet(x, y, params, options.colors);
			idx[j * W + i] = nearestIndex(c, palette);
		}
	}
	return encodeSixel(W, H, idx, palette, { transparent: FAINT_TRANSPARENT });
}
