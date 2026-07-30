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

import { mixRgb, type PetColors, type PetParams, type Rgb, shadePetWithCoverage } from "./pet-geometry.ts";

/** DCS introducer for a sixel image. `isImageLine()` keys off this substring so
 * the differential renderer leaves sixel lines untouched. */
export const SIXEL_INTRO = "\x1bP";

const ST = "\x1b\\";

/** Vertical pixels a sixel band covers — the format's atom of height. */
export const SIXEL_BAND_HEIGHT = 6;

/**
 * Largest sixel height, in pixels, that fits in `availablePx` WITHOUT a partial
 * band — i.e. the largest multiple of {@link SIXEL_BAND_HEIGHT} that still fits.
 *
 * Why callers must round through this instead of passing a row count times the
 * cell height: a sixel's height is stated twice, and terminals disagree about
 * which statement wins. The raster attributes carry the exact pixel height, but
 * the pixels themselves arrive in 6-row bands, and a terminal that sizes the
 * image by the bands it received (rather than by the attributes) advances a FULL
 * band for the last one even when only a pixel of it is set. A 3-row sprite on a
 * 17px cell asks for 51px, which is 8.5 bands — the terminal rounds that to 9 and
 * draws 54px, three pixels past the rows the frame reserved. At the bottom of the
 * screen those three pixels make the terminal scroll, and a scroll is invisible to
 * the differential renderer: every tracked row index shifts, and each repaint of a
 * live line prints one row lower than the last (the stacked-"Thinking…" bug).
 *
 * Quantizing here makes both readings of the height agree, so the drawing lands
 * inside its reservation on every terminal instead of only the strict ones.
 *
 * Never returns 0 — a caller with less than one band of room gets one band and is
 * expected to have reserved a row for it (cells below ~6px tall are not a real
 * configuration; {@link ./terminal-image.ts} floors a measured cell well above it).
 */
export function fitSixelHeightPx(availablePx: number): number {
	const bands = Math.floor(availablePx / SIXEL_BAND_HEIGHT);
	return Math.max(1, bands) * SIXEL_BAND_HEIGHT;
}

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

	const bandCount = Math.ceil(height / SIXEL_BAND_HEIGHT);
	// Band separators are emitted LAZILY: a `-` advances the cursor into the next
	// band, so one that is never followed by pixels still costs 6px of height on
	// terminals that size an image by the bands it received. Holding them until
	// there is something to draw keeps the separators that POSITION later bands
	// (skipping a blank band in the middle) while never leaving a trailing one.
	//
	// This matters for the pet specifically: its silhouette floats, so the bottom
	// band is often fully transparent and emits nothing at all. Suppressing only
	// the literal last separator would leave that band's own separator dangling.
	let pendingSeparators = 0;
	for (let band = 0; band < bandCount; band++) {
		const y0 = band * SIXEL_BAND_HEIGHT;
		let bandOut = "";
		// Which colors actually appear in this band (skip a full palette sweep).
		const used = new Set<number>();
		for (let j = y0; j < Math.min(y0 + SIXEL_BAND_HEIGHT, height); j++) {
			for (let i = 0; i < width; i++) used.add(indices[j * width + i]!);
		}
		let first = true;
		for (const color of used) {
			if (transparent.has(color)) continue;
			if (!first) bandOut += "$"; // carriage return within the band: overlay next color
			first = false;
			bandOut += `#${color}`;
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
				for (let dy = 0; dy < SIXEL_BAND_HEIGHT; dy++) {
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
			bandOut += run;
		}
		if (bandOut !== "") {
			// Only now are the held separators known to be positioning real pixels.
			if (pendingSeparators > 0) {
				out += "-".repeat(pendingSeparators);
				pendingSeparators = 0;
			}
			out += bandOut;
		}
		if (band < bandCount - 1) pendingSeparators++;
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

/**
 * Palette index for a shaded pixel, without searching the palette.
 *
 * The palette is two linear ramps off `bg` (see {@link buildPetPalette}), so a
 * pixel covered by only ONE feature lands exactly on a ramp entry and its index
 * is arithmetic: the coverage times the ramp resolution. `nearestIndex` was
 * rediscovering that by scanning all 41 entries per pixel — 189k distance
 * evaluations for a 96×48 sprite, ~37% of the encode.
 *
 * Where both features cover the same pixel (the eye's anti-aliased rim over the
 * head) the shaded color is a composite that sits off both ramps, and only the
 * nearest-color search gives the same answer as before. That is a thin outline,
 * so the search stays for it and the output is unchanged pixel for pixel.
 */
function paletteIndex(color: Rgb, stroke: number, eye: number, palette: readonly Rgb[]): number {
	if (eye === 0) return STROKE_BASE + Math.round(stroke * RAMP_STEPS);
	if (stroke === 0) {
		const step = Math.round(eye * RAMP_STEPS);
		// Ramp entry 0 of the eye ramp IS bg, which lives at STROKE_BASE.
		return step === 0 ? STROKE_BASE : EYE_BASE + step - 1;
	}
	return nearestIndex(color, palette);
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
	// Superset of PetParams — forwarded whole so new animation channels reach the
	// shader without being re-listed here (mirrors ./pet-cells.ts).
	const params: PetParams = options;
	const idx = new Uint8Array(W * H);
	for (let j = 0; j < H; j++) {
		for (let i = 0; i < W; i++) {
			const x = (i / W) * 2 - 1;
			const y = j / H - 0.5;
			const { color, stroke, eye } = shadePetWithCoverage(x, y, params, options.colors);
			idx[j * W + i] = paletteIndex(color, stroke, eye, palette);
		}
	}
	return encodeSixel(W, H, idx, palette, { transparent: FAINT_TRANSPARENT });
}
