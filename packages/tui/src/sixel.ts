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
 * Hard caps on pet sixel pixel dimensions. Huge cell sizes (or misreported
 * metrics) would otherwise make the shade loop scale with W×H without bound.
 * When either dimension exceeds its cap, {@link renderPetSixel} scales both
 * axes down proportionally (aspect preserved). Normal terminal cell footprints
 * stay well under these limits, so the cap is a safety valve rather than a
 * visual change.
 *
 * **Band floor (do not drop):** after the proportional scale, height is floored
 * to a multiple of {@link SIXEL_BAND_HEIGHT} (never rounded up past the cap),
 * then width is re-derived from the original aspect. A partial last band is
 * treated as a full 6px band by some terminals and can scroll the bottom of the
 * screen under the differential renderer — the same failure mode
 * {@link fitSixelHeightPx} exists to prevent. Tests assert `height % 6 === 0`
 * on capped output; any rewrite of the cap path must keep that invariant.
 */
export const PET_SIXEL_MAX_WIDTH = 128;
/**
 * Max pet sixel height in pixels. Prefer a multiple of {@link SIXEL_BAND_HEIGHT}
 * so the cap itself is band-aligned (64 = 10⅔ bands would be wrong as a *final*
 * height; the implementer floors to 60). See {@link PET_SIXEL_MAX_WIDTH}.
 */
export const PET_SIXEL_MAX_HEIGHT = 64;

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
	// Build via parts + join to avoid quadratic `out +=` churn on large sprites.
	const parts: string[] = [`${SIXEL_INTRO}0;1;0q"1;1;${width};${height}`];
	for (let i = 0; i < palette.length; i++) {
		const p = palette[i]!;
		parts.push(`#${i};2;${channelToPct(p[0])};${channelToPct(p[1])};${channelToPct(p[2])}`);
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
				parts.push("-".repeat(pendingSeparators));
				pendingSeparators = 0;
			}
			parts.push(bandOut);
		}
		if (band < bandCount - 1) pendingSeparators++;
	}

	parts.push(ST);
	return parts.join("");
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

// --- Pet palette cache -------------------------------------------------------
// Keyed by the three RGB triples (stroke / eye / bg). Reuses the same palette
// array reference when colors are unchanged so hot frames avoid 41 mixRgb calls.

let cachedPetPalette: Rgb[] | null = null;
let cachedPetPaletteBg: Rgb | null = null;
let cachedPetPaletteStroke: Rgb | null = null;
let cachedPetPaletteEye: Rgb | null = null;

function rgbEqual(a: Rgb, b: Rgb): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function buildPetPalette(colors: PetColors): Rgb[] {
	const palette: Rgb[] = [];
	for (let i = 0; i <= RAMP_STEPS; i++) palette.push(mixRgb(colors.bg, colors.stroke, i / RAMP_STEPS));
	for (let i = 1; i <= RAMP_STEPS; i++) palette.push(mixRgb(colors.bg, colors.eye, i / RAMP_STEPS));
	return palette;
}

/** Return a palette for `colors`, reusing the cached array when the triples match. */
function getPetPalette(colors: PetColors): Rgb[] {
	if (
		cachedPetPalette &&
		cachedPetPaletteBg &&
		cachedPetPaletteStroke &&
		cachedPetPaletteEye &&
		rgbEqual(cachedPetPaletteBg, colors.bg) &&
		rgbEqual(cachedPetPaletteStroke, colors.stroke) &&
		rgbEqual(cachedPetPaletteEye, colors.eye)
	) {
		return cachedPetPalette;
	}
	cachedPetPalette = buildPetPalette(colors);
	cachedPetPaletteBg = colors.bg;
	cachedPetPaletteStroke = colors.stroke;
	cachedPetPaletteEye = colors.eye;
	return cachedPetPalette;
}

// --- Reusable indices buffer -------------------------------------------------
// Module-level scratch for `renderPetSixel`. Grows when W*H exceeds capacity;
// never shrinks mid-session. **Single-threaded only** — concurrent calls would
// race on this buffer; the TUI path is serial so that is fine.

let petIndicesBuf: Uint8Array | null = null;

function getPetIndicesBuf(size: number): Uint8Array {
	if (!petIndicesBuf || petIndicesBuf.length < size) {
		petIndicesBuf = new Uint8Array(size);
	}
	return petIndicesBuf;
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

/**
 * Conservative axis-aligned bbox of the pet silhouette in normalized canvas
 * space (`x ∈ [-1,1]`, `y ∈ [-0.5,0.5]`).
 *
 * Built from the head half-extents (±0.6 × ±0.33) plus stroke/eye AA margins,
 * then expanded by the body transform (squash → tilt → bob). Must never clip the
 * drawn silhouette — over-culling is wrong, under-culling only costs cycles.
 */
function petCanvasBBox(params: PetParams): { x0: number; x1: number; y0: number; y1: number } {
	// Head half-extents from pet-geometry; pad covers stroke ring AA (~0.045) and
	// any eyeScale/shift that peeks past the head for extreme mood params.
	const LOCAL_HX = 0.6 + 0.1;
	const LOCAL_HY = 0.33 + 0.1;
	// Match pet-geometry's MAX_SQUASH clamp so the cull tracks the drawn shape.
	const MAX_SQUASH = 0.45;
	const squash = Math.max(-MAX_SQUASH, Math.min(MAX_SQUASH, params.squash ?? 0));
	// Forward body scale (inverse of toLocalPoint's divide): wider/shorter or
	// taller/narrower depending on the sign of squash.
	const hx = LOCAL_HX * (1 + squash);
	const hy = LOCAL_HY * (1 - squash);
	const tilt = params.tilt ?? 0;
	const c = Math.abs(Math.cos(tilt));
	const s = Math.abs(Math.sin(tilt));
	// AABB of a rectangle with half-extents (hx, hy) after roll by `tilt`.
	const halfW = c * Math.abs(hx) + s * Math.abs(hy);
	const halfH = s * Math.abs(hx) + c * Math.abs(hy);
	const bobX = params.bobX ?? 0;
	const bobY = params.bobY ?? 0;
	return {
		x0: bobX - halfW,
		x1: bobX + halfW,
		y0: bobY - halfH,
		y1: bobY + halfH,
	};
}

export interface RenderPetSixelOptions extends PetParams {
	colors: PetColors;
}

/**
 * Render the pet as a transparent sixel string, ready to write to a
 * sixel-capable terminal. `widthPx × heightPx` are device pixels (use the
 * terminal's reported cell size to map to a target cell footprint).
 *
 * ## Size policy
 *
 * 1. **Cap** — if either axis exceeds {@link PET_SIXEL_MAX_WIDTH} /
 *    {@link PET_SIXEL_MAX_HEIGHT}, scale both down proportionally.
 * 2. **Band floor** — final height is always a multiple of
 *    {@link SIXEL_BAND_HEIGHT} (floored, never rounded up past the cap). Width
 *    is re-derived from the pre-cap aspect so the silhouette stays ~2:1 after
 *    the floor. Under-cap callers that pass a non-aligned `heightPx` go through
 *    {@link fitSixelHeightPx} for the same reason.
 *
 * Skipping the band floor reintroduces the stacked-"Thinking…" scroll bug when
 * a terminal sizes the image by band count rather than raster attributes.
 */
export function renderPetSixel(widthPx: number, heightPx: number, options: RenderPetSixelOptions): string {
	let W = Math.max(1, Math.round(widthPx));
	let H = Math.max(1, Math.round(heightPx));
	// Cap → band-floor H → re-derive W (see function JSDoc "Size policy").
	if (W > PET_SIXEL_MAX_WIDTH || H > PET_SIXEL_MAX_HEIGHT) {
		const aspect = W / H;
		const scale = Math.min(PET_SIXEL_MAX_WIDTH / W, PET_SIXEL_MAX_HEIGHT / H);
		H = Math.max(1, Math.round(H * scale));
		// Largest multiple of SIXEL_BAND_HEIGHT that still fits under the cap.
		H = Math.floor(Math.min(H, PET_SIXEL_MAX_HEIGHT) / SIXEL_BAND_HEIGHT) * SIXEL_BAND_HEIGHT;
		if (H < SIXEL_BAND_HEIGHT) H = SIXEL_BAND_HEIGHT;
		W = Math.max(1, Math.min(PET_SIXEL_MAX_WIDTH, Math.round(H * aspect)));
	} else if (H % SIXEL_BAND_HEIGHT !== 0) {
		// Under-cap but unaligned: floor to a whole band count (never expand past
		// the caller's request the way a ceil would).
		H = fitSixelHeightPx(H);
	}
	const palette = getPetPalette(options.colors);
	// Superset of PetParams — forwarded whole so new animation channels reach the
	// shader without being re-listed here (mirrors ./pet-cells.ts).
	const params: PetParams = options;
	const pixelCount = W * H;
	const idx = getPetIndicesBuf(pixelCount);
	// STROKE_BASE is 0 / transparent. Clear the used span so reused buffer tails
	// and culled regions never leak previous-frame indices.
	idx.fill(STROKE_BASE, 0, pixelCount);

	const bbox = petCanvasBBox(params);
	// Map normalized canvas bbox → inclusive pixel ranges. One-pixel pad so
	// sampling at pixel centers never misses an edge under rounding.
	//   x = (i / W) * 2 - 1  ⇒  i = (x + 1) * W / 2
	//   y = j / H - 0.5      ⇒  j = (y + 0.5) * H
	const i0 = Math.max(0, Math.floor(((bbox.x0 + 1) * W) / 2) - 1);
	const i1 = Math.min(W - 1, Math.ceil(((bbox.x1 + 1) * W) / 2) + 1);
	const j0 = Math.max(0, Math.floor((bbox.y0 + 0.5) * H) - 1);
	const j1 = Math.min(H - 1, Math.ceil((bbox.y1 + 0.5) * H) + 1);

	for (let j = j0; j <= j1; j++) {
		const y = j / H - 0.5;
		const row = j * W;
		for (let i = i0; i <= i1; i++) {
			const x = (i / W) * 2 - 1;
			const { color, stroke, eye } = shadePetWithCoverage(x, y, params, options.colors);
			idx[row + i] = paletteIndex(color, stroke, eye, palette);
		}
	}
	return encodeSixel(W, H, idx, palette, { transparent: FAINT_TRANSPARENT });
}
