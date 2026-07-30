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

/**
 * Per-frame scene parameters.
 *
 * Two families: the EYES (`blinkK`, `eyeShift`, `eyeShiftY`, `eyeScale`) move
 * inside the head, and the BODY (`bobX`, `bobY`, `tilt`, `squash`) rigid-body
 * transforms the whole mascot — head and eyes together. Body motion is applied
 * by mapping the sample point back into the pet's local frame
 * ({@link toLocalPoint}), so the silhouette is never redrawn, only moved: the
 * approved shape survives every animation.
 *
 * Every field but `blinkK` is optional and defaults to "at rest", so a caller
 * that only knows about eyes (the startup hero, older tests) renders exactly the
 * frame it always did.
 */
export interface PetParams {
	/**
	 * Vertical eye scale: `1` fully open, `~0.08` a squint/closed blink. Multiplies
	 * the eye ellipse's y-radius, so a low value flattens the eyes into a line.
	 */
	blinkK: number;
	/** Horizontal eye offset (mood/gaze). `0` = centered. */
	eyeShift?: number;
	/** Vertical gaze offset. Negative looks up, positive looks down. */
	eyeShiftY?: number;
	/** Uniform eye size multiplier: `>1` widens (startle), `<1` narrows (focus). */
	eyeScale?: number;
	/** Whole-body horizontal offset (shakes). `0` = centered. */
	bobX?: number;
	/** Whole-body vertical offset (breathing, hops). Negative lifts the pet. */
	bobY?: number;
	/** Whole-body roll in radians. Positive tips the head to the right. */
	tilt?: number;
	/**
	 * Squash & stretch: `>0` flattens (wider, shorter), `<0` stretches (taller,
	 * narrower). Clamped to ±{@link MAX_SQUASH} so the shape can never invert.
	 */
	squash?: number;
}

/** Hard bound on `squash` — beyond this the rounded box degenerates. */
const MAX_SQUASH = 0.45;

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
 * Map a canvas point into the pet's local frame — the inverse of the body
 * transform (translate by `bob`, roll by `tilt`, then squash & stretch). Sampling
 * the SDFs at this point is what makes the mascot *move* without the shape ever
 * being re-authored.
 *
 * The canvas is 2:1 in BOTH units and pixels (x spans 2 over `W`, y spans 1 over
 * `H = W / 2`), so one x-unit and one y-unit are the same number of pixels and
 * the rotation stays isotropic — no aspect correction needed.
 */
export function toLocalPoint(x: number, y: number, params: PetParams): { x: number; y: number } {
	let lx = x - (params.bobX ?? 0);
	let ly = y - (params.bobY ?? 0);
	const tilt = params.tilt ?? 0;
	if (tilt !== 0) {
		const c = Math.cos(tilt);
		const s = Math.sin(tilt);
		const rx = lx * c + ly * s;
		ly = -lx * s + ly * c;
		lx = rx;
	}
	const squash = Math.max(-MAX_SQUASH, Math.min(MAX_SQUASH, params.squash ?? 0));
	if (squash !== 0) {
		lx /= 1 + squash;
		ly /= 1 - squash;
	}
	return { x: lx, y: ly };
}

/**
 * Coverage of the two features at a normalized point, independent of color.
 * Returns `stroke` (head outline, a ring) and `eye` (max of both eyes) each in
 * `[0, 1]`. Kept color-free so tests can assert exact silhouette values.
 */
export function petCoverage(x: number, y: number, params: PetParams): { stroke: number; eye: number } {
	const p = toLocalPoint(x, y, params);
	const blinkK = params.blinkK;
	const eyeShift = params.eyeShift ?? 0;
	const eyeShiftY = params.eyeShiftY ?? 0;
	const eyeScale = params.eyeScale ?? 1;
	const stroke = coverage(STROKE_EDGE, Math.abs(sdRoundBox(p.x, p.y, HEAD_BX, HEAD_BY, HEAD_R)));
	const rx = EYE_RX * eyeScale;
	const ry = EYE_RY * eyeScale * blinkK;
	const eyeY = p.y + EYE_Y - eyeShiftY;
	const eL = sdEllipse(p.x + EYE_X - eyeShift, eyeY, rx, ry);
	const eR = sdEllipse(p.x - EYE_X - eyeShift, eyeY, rx, ry);
	const eye = Math.max(coverage(EYE_EDGE, eL), coverage(EYE_EDGE, eR));
	return { stroke, eye };
}

/**
 * Final blended color at a normalized point: `bg`, then the head stroke over it
 * by stroke coverage, then the eye over that by eye coverage. This is the single
 * source of truth for pixel color, shared by the sixel and cell renderers.
 */
export function shadePet(x: number, y: number, params: PetParams, colors: PetColors): Rgb {
	return shadePetWithCoverage(x, y, params, colors).color;
}

/**
 * {@link shadePet} plus the coverages it was computed from.
 *
 * Both renderers need the coverage as well as the color — the cell renderer for
 * the alpha of a half-block, the sixel renderer to know which palette ramp the
 * pixel came from. Calling `shadePet` and then `petCoverage` evaluated the same
 * three SDFs twice per sample, which was ~40% of the cell shading loop; the
 * sixel encoder paid for it differently, by searching the whole palette to
 * recover information it had just thrown away.
 */
export function shadePetWithCoverage(
	x: number,
	y: number,
	params: PetParams,
	colors: PetColors,
): { color: Rgb; stroke: number; eye: number } {
	const { stroke, eye } = petCoverage(x, y, params);
	let c: Rgb = colors.bg;
	if (stroke > 0) c = mixRgb(c, colors.stroke, stroke);
	if (eye > 0) c = mixRgb(c, colors.eye, eye);
	return { color: c, stroke, eye };
}
