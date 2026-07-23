/**
 * Pet geometry — the pure, resolution-independent scene for Pit's mascot.
 *
 * A rounded-rectangle head (SDF ring) plus two elliptical eyes, evaluated in a
 * normalized 2:1 canvas: `x ∈ [-1, 1]`, `y ∈ [-0.5, 0.5]`. Every renderer (the
 * sixel encoder in {@link ./sixel.ts} and the half-block fallback in
 * {@link ./pet-cells.ts}) samples THIS module so the silhouette is byte-for-byte
 * identical across transports. Nothing here touches the terminal, colors are
 * injected by the caller, and the functions are deterministic — trivially unit
 * testable.
 *
 * The math (SDFs, coverage ramp, sample offsets, eye radii) is ported verbatim
 * from the approved visual mocks so the rendered pet matches the sign-off frame.
 */

/** An RGB triple, channels in `[0, 255]`. Tuples (not objects) to stay cheap in
 * the per-pixel hot loop. */
export type Rgb = readonly [number, number, number];

/** Colors injected into the scene. `bg` is the blend/anti-alias target (the
 * surface the pet sits on), `stroke` the head outline, `eye` the eye fill. */
export interface PetColors {
	/** Blend target for anti-aliased edges (≈ the terminal/background color). */
	bg: Rgb;
	/** Head outline color (a strong foreground). */
	stroke: Rgb;
	/** Eye fill color (the green accent). */
	eye: Rgb;
}

/** Per-frame scene parameters. */
export interface PetParams {
	/**
	 * Vertical eye scale: `1` fully open, `~0.08` a squint/closed blink. Multiplies
	 * the eye ellipse's y-radius, so a low value flattens the eyes into a line.
	 */
	blinkK: number;
	/** Horizontal eye offset (mood/gaze). `0` = centered. */
	eyeShift?: number;
}

/** Signed distance to a rounded box centered at the origin, half-extents
 * `(bx, by)`, corner radius `r`. Negative inside, positive outside. */
export function sdRoundBox(px: number, py: number, bx: number, by: number, r: number): number {
	const qx = Math.abs(px) - bx + r;
	const qy = Math.abs(py) - by + r;
	return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance (approximate) to an axis-aligned ellipse with radii
 * `(rx, ry)`. Good enough for anti-aliased fills. */
export function sdEllipse(px: number, py: number, rx: number, ry: number): number {
	return (Math.hypot(px / rx, py / ry) - 1) * Math.min(rx, ry);
}

/**
 * Coverage ramp: `1` well inside the shape, `0` well outside, with a soft ~1px
 * edge so anti-aliasing reads cleanly. `edge` widens/narrows the covered band;
 * `d` is a signed distance (typically `Math.abs(sdf)` for a ring, or the raw sdf
 * for a fill).
 */
export function coverage(edge: number, d: number): number {
	return Math.max(0, Math.min(1, 1 - (d - edge + 0.01) / 0.02));
}

/** Linear per-channel blend `a → b` by `k ∈ [0, 1]`. */
export function mixRgb(a: Rgb, b: Rgb, k: number): Rgb {
	return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

// --- Scene constants (normalized space) -------------------------------------
// Head: rounded box, half-extents 0.6 x 0.33, corner radius 0.3.
const HEAD_BX = 0.6;
const HEAD_BY = 0.33;
const HEAD_R = 0.3;
const STROKE_EDGE = 0.035;
// Eyes: two ellipses at x = ±0.24, slightly above center, radii 0.075 x 0.13.
const EYE_X = 0.24;
const EYE_Y = -0.02;
const EYE_RX = 0.075;
const EYE_RY = 0.13;
const EYE_EDGE = 0.008;

/**
 * Coverage of the two features at a normalized point, independent of color.
 * Returns `stroke` (head outline, a ring) and `eye` (max of both eyes) each in
 * `[0, 1]`. Kept color-free so tests can assert exact silhouette values.
 */
export function petCoverage(x: number, y: number, params: PetParams): { stroke: number; eye: number } {
	const blinkK = params.blinkK;
	const eyeShift = params.eyeShift ?? 0;
	const stroke = coverage(STROKE_EDGE, Math.abs(sdRoundBox(x, y, HEAD_BX, HEAD_BY, HEAD_R)));
	const eL = sdEllipse(x + EYE_X - eyeShift, y + EYE_Y, EYE_RX, EYE_RY * blinkK);
	const eR = sdEllipse(x - EYE_X - eyeShift, y + EYE_Y, EYE_RX, EYE_RY * blinkK);
	const eye = Math.max(coverage(EYE_EDGE, eL), coverage(EYE_EDGE, eR));
	return { stroke, eye };
}

/**
 * Final blended color at a normalized point: `bg`, then the head stroke over it
 * by stroke coverage, then the eye over that by eye coverage. This is the single
 * source of truth for pixel color, shared by the sixel and cell renderers.
 */
export function shadePet(x: number, y: number, params: PetParams, colors: PetColors): Rgb {
	const { stroke, eye } = petCoverage(x, y, params);
	let c: Rgb = colors.bg;
	if (stroke > 0) c = mixRgb(c, colors.stroke, stroke);
	if (eye > 0) c = mixRgb(c, colors.eye, eye);
	return c;
}
