/**
 * PetCompanion — the mid-conversation mascot that perches on its OWN rows
 * directly above the input editor, aligned to the right edge ("perched" on the
 * composer box). Eyes AND body animate with the agent's mood ({@link PetMood}):
 * it breathes while idle, leans in while you type, hops while a tool runs, and
 * dozes off when the session goes quiet.
 *
 * WHERE / HOW IT DRAWS: the pet owns dedicated rows in the composer perch (see
 * {@link ComposerChrome.setPerch}), so — unlike the old side-gutter companion
 * that shared rows with the editor — it can render at full sprite resolution:
 *
 *   - SIXEL when {@link getSixelSupport}: reuses the proven startup-screen
 *     pattern. `PET_PERCH_SIXEL_ROWS - 1` blank rows plus a final image line
 *     that self-clears the reserved rows and pins the cursor with DECSC/DECRC,
 *     so the transparent sprite draws into its rows without disturbing the
 *     renderer's row accounting (see {@link buildPetSixelLines} in
 *     startup-screen.ts for the full rationale). `isImageLine()` keeps the
 *     differential renderer from measuring or slicing that row.
 *   - half-block CELLS otherwise: a small anti-aliased block, right-aligned.
 *
 * The pet no longer shares a terminal row with the editor, so the sixel-vs-cell
 * choice is now purely about fidelity — sixel is the crisp default and cells are
 * the universal fallback (the old low-res "rock" beside the input is gone).
 *
 * The component memoizes its rendered lines by (width, sixel-vs-cell, quantized
 * params, colors) so a frame where nothing about the pet changed hands back the
 * SAME array reference, letting the ComposerChrome cache hit while the pet idles.
 * On top of that memo sits a frame-rate governor ({@link PetCompanion.sampleAt}):
 * the mood is sampled on a clock quantized to its own repaint cadence, so
 * continuous motion (breathing, sweeps, hops) costs a handful of sprite encodes
 * per second instead of one per 16 ms ticker frame.
 */

import { performance } from "node:perf_hooks";
import {
	areCellDimensionsMeasured,
	type Component,
	fitSixelHeightPx,
	getCellDimensions,
	getSixelSupport,
	type PetColors,
	type PetParams,
	renderPetCells,
	renderPetSixel,
} from "@pit/tui";
import {
	isAmbientReplaceable,
	PetMood,
	type PetMoodOptions,
	type PetMoodState,
	petFrameIntervalMs,
} from "./pet-mood.ts";

/** Below this terminal width the perch hides and the editor keeps the full width. */
export const PET_COMPANION_MIN_COLS = 100;

/**
 * Reserved rows for the sixel perch. The sprite is drawn into the TOP
 * {@link PET_PERCH_SIXEL_DRAW_ROWS} of them; the last one is deliberate slack.
 *
 * That spare row is not cosmetic — it is what keeps the perch from corrupting the
 * screen. A sixel draws downward in device pixels, and the pixel→row conversion
 * is only ever as good as the terminal's reported cell size: band rounding (6 px
 * granularity) and a cell size the terminal padded differently than it reports can
 * each push the drawing a fraction of a row past where it was meant to stop. One
 * row below the perch there is the editor; below THAT, at the bottom of a full
 * screen, there is nothing — and a sixel that reaches the last row scrolls the
 * terminal, which the differential renderer cannot see and never recovers from
 * (see TUI.guardTrailingImageLine). Overflow lands in the slack row instead, where
 * it costs nothing: the row is blank and the perch repaints it anyway.
 */
export const PET_PERCH_SIXEL_ROWS = 4;
/** Rows the sprite actually draws into — one less than it reserves. */
export const PET_PERCH_SIXEL_DRAW_ROWS = PET_PERCH_SIXEL_ROWS - 1;
/** Sixel canvas aspect (width : height). ~96×48px on a standard 16px cell. */
const PET_PERCH_ASPECT = 2;
/** Half-block cell fallback footprint (rows × cols). */
export const PET_PERCH_CELL_ROWS = 4;
export const PET_PERCH_CELL_COLS = 16;

/**
 * Floor for sixel sample cadence (~15 fps). Full sixel erase + encode + write is
 * much heavier than half-block cells; capping idle/busy sixel below the cell
 * ladder cuts terminal traffic and flicker without slowing the cell path.
 */
const PET_SIXEL_MIN_INTERVAL_MS = 66;
/** 30 fps only while crossfading so a new mood has visible intermediate poses. */
const PET_SIXEL_TRANSITION_INTERVAL_MS = 33;
/** Keep the low-traffic cell transport briefly after stdout drains. */
const PET_SIXEL_BACKPRESSURE_RECOVERY_MS = 500;

/**
 * Pose quantization scale (4 decimal places). Matches the old `toFixed(4)` frame
 * key resolution — float-dust immunity, not pixel bucketing.
 */
const POSE_Q = 10_000;

/** Moods with short, high-motion windows that prefer cells over sixel (see render). */
const SHORT_TRANSIENT_MOODS: ReadonlySet<PetMoodState> = new Set(["done", "error", "startled"]);

export interface PetCompanionOptions extends PetMoodOptions {
	/** Resolved pet colors, read fresh each render so a theme switch is picked up. */
	getColors: () => PetColors;
	/** Injectable clock (defaults to performance.now) for the render-time sample. */
	clock?: () => number;
	/** True while terminal output is congested; cells avoid a large sixel rewrite. */
	isBackpressured?: () => boolean;
}

/**
 * Repaint interval for the active transport. Cells keep the mood ladder from
 * {@link petFrameIntervalMs}; steady sixel never samples faster than
 * {@link PET_SIXEL_MIN_INTERVAL_MS} (~15 fps). During a mood crossfade, sixel
 * temporarily uses {@link PET_SIXEL_TRANSITION_INTERVAL_MS} so the 100ms blend
 * produces several visible poses before returning to the low-traffic cadence.
 */
export function petFrameIntervalMsForTransport(state: PetMoodState, sixel: boolean, crossfading = false): number {
	const base = petFrameIntervalMs(state);
	if (!sixel) return base;
	return crossfading ? PET_SIXEL_TRANSITION_INTERVAL_MS : Math.max(base, PET_SIXEL_MIN_INTERVAL_MS);
}

/** Quantize a pose channel to 4-decimal fixed point (integer). */
function quantPose(v: number): number {
	return Math.round(v * POSE_Q);
}

/**
 * True when two poses match at 4-decimal resolution. Replaces the old string
 * `frameKey` (toFixed + join) so tick/render memo comparisons allocate nothing.
 */
function samePose(a: PetParams, b: PetParams): boolean {
	return (
		quantPose(a.blinkK) === quantPose(b.blinkK) &&
		quantPose(a.eyeShift ?? 0) === quantPose(b.eyeShift ?? 0) &&
		quantPose(a.eyeShiftY ?? 0) === quantPose(b.eyeShiftY ?? 0) &&
		quantPose(a.eyeScale ?? 1) === quantPose(b.eyeScale ?? 1) &&
		quantPose(a.bobX ?? 0) === quantPose(b.bobX ?? 0) &&
		quantPose(a.bobY ?? 0) === quantPose(b.bobY ?? 0) &&
		quantPose(a.tilt ?? 0) === quantPose(b.tilt ?? 0) &&
		quantPose(a.squash ?? 0) === quantPose(b.squash ?? 0)
	);
}

function sameColors(a: PetColors, b: PetColors): boolean {
	const as = a.stroke;
	const bs = b.stroke;
	const ae = a.eye;
	const be = b.eye;
	const ab = a.bg;
	const bb = b.bg;
	return (
		as[0] === bs[0] &&
		as[1] === bs[1] &&
		as[2] === bs[2] &&
		ae[0] === be[0] &&
		ae[1] === be[1] &&
		ae[2] === be[2] &&
		ab[0] === bb[0] &&
		ab[1] === bb[1] &&
		ab[2] === bb[2]
	);
}

export class PetCompanion implements Component {
	private readonly mood: PetMood;
	private readonly getColors: () => PetColors;
	private readonly clock: () => number;
	private readonly reducedMotion: boolean;
	private readonly isBackpressured: () => boolean;
	private sixelCooldownUntil = 0;
	// Dirty-tracking for the ticker: last pose that requested a render.
	private lastTickParams: PetParams | undefined;
	// Render memo: identical (width, mode, params, colors) hands back the same array.
	private memoWidth = -1;
	private memoSixel = false;
	private memoParams: PetParams | undefined;
	private memoColors: PetColors | undefined;
	private renderLines: string[] = [];
	// Standing user-driven state (draft in the composer or not), independent of what
	// the turn is doing. See setAmbientMood / tick.
	private ambientBaseline: PetMoodState = "idle";

	constructor(options: PetCompanionOptions) {
		this.getColors = options.getColors;
		this.clock = options.clock ?? (() => performance.now());
		this.reducedMotion = options.reducedMotion ?? false;
		this.isBackpressured = options.isBackpressured ?? (() => false);
		this.mood = new PetMood(options);
	}

	get moodState(): PetMoodState {
		return this.mood.current;
	}

	/** Transition the mascot's mood in response to an agent lifecycle event. */
	setMood(state: PetMoodState, now: number = this.clock()): void {
		this.mood.setState(state, now);
	}

	/**
	 * Ambient (user-driven) mood request — typing, going quiet. Unlike
	 * {@link setMood} it yields to whatever the turn is doing: a keystroke must
	 * never pull the pet out of `working` and back into `watching`.
	 *
	 * Also records the request as the STANDING ambient state, which is what makes
	 * it survive a turn. Ambient signals only arrive on editor input, so without
	 * this a draft left in the composer while the agent worked would come out the
	 * other side wrong: the turn ends, `done` expires into `idle`, and the pet sits
	 * upright over text it is supposed to be leaning toward until the user happens
	 * to press another key. {@link tick} reapplies the baseline instead.
	 */
	setAmbientMood(state: PetMoodState, now: number = this.clock()): void {
		// Any ambient signal is a sign of life, even when the mood is unchanged:
		// typing into a composer the pet already watches must not let it doze off.
		this.ambientBaseline = state;
		this.mood.keepAwake(now);
		if (isAmbientReplaceable(this.mood.current)) this.mood.setState(state, now);
	}

	/**
	 * Whether this frame will emit sixel (vs half-block cells). Same capability
	 * check as render: measured cell size required. Short hop/shake moods and
	 * congested output force cells so a large sixel rewrite cannot worsen a stall.
	 * The short cooldown survives the drain event: TUI resumes rendering as soon as
	 * stdout drains, while the pet remains on its low-traffic transport briefly.
	 */
	private usesSixelTransport(now = this.clock()): boolean {
		if (!(getSixelSupport() && areCellDimensionsMeasured())) return false;
		if (this.isBackpressured()) {
			this.sixelCooldownUntil = Math.max(this.sixelCooldownUntil, now + PET_SIXEL_BACKPRESSURE_RECOVERY_MS);
			return false;
		}
		if (now < this.sixelCooldownUntil) return false;
		// done/error/startled: prefer cells (see render).
		if (SHORT_TRANSIENT_MOODS.has(this.mood.current)) return false;
		return true;
	}

	/**
	 * Sample clock for the CURRENT mood, quantized from the state's entry time.
	 * This lets a mood changed between global ticker slots render its first pose
	 * immediately, rather than sampling before it existed. A pending crossfade
	 * temporarily raises sixel to 30 fps; steady sixel remains capped at 15 fps.
	 */
	private sampleAt(now: number): number {
		const step = petFrameIntervalMsForTransport(
			this.mood.current,
			this.usesSixelTransport(now),
			this.mood.hasPendingCrossfade,
		);
		return this.mood.sampleAt(now, step);
	}

	/**
	 * Shared-ticker hook (mirrors StartupScreen.tick). Advances transient moods
	 * and reports whether the pet's appearance changed enough to warrant a
	 * repaint. No-op under reduced motion.
	 */
	tick(now: number): boolean {
		if (this.reducedMotion) return false;
		let stateChanged = this.mood.tick(now);
		// A transient that just expired lands on `idle` by construction; if the user
		// has a draft standing in the composer, `idle` is the wrong resting place.
		// Only redirect on the frame the mood actually settled, so this never fights
		// the sleep timer (which moves idle → sleepy on its own later).
		if (stateChanged && this.mood.current === "idle" && this.ambientBaseline !== "idle") {
			stateChanged = this.mood.setState(this.ambientBaseline, now) || stateChanged;
		}
		// Rate limiter is {@link sampleAt} alone: params are on a clock already
		// quantized to the mood/transport cadence, so a moving pose dirties once per
		// sample. A static pose (e.g. reduced-motion `{ blinkK: 1 }`) compares equal
		// at 4-decimal resolution and never repaints. Field-wise quant compare — no
		// string key — keeps the hot path allocation-free.
		const params = this.mood.params(this.sampleAt(now));
		const poseChanged = !this.lastTickParams || !samePose(params, this.lastTickParams);
		this.lastTickParams = params;
		return stateChanged || poseChanged;
	}

	invalidate(): void {
		this.memoWidth = -1;
		this.memoParams = undefined;
	}

	render(width: number): string[] {
		const params = this.mood.params(this.sampleAt(this.clock()));
		const colors = this.getColors();
		// Sixel needs a MEASURED cell size, not the built-in guess: the sprite's
		// pixel height is converted into terminal rows, and a guess that runs tall
		// draws past the reserved block. The startup hero can afford the guess (top
		// of the screen, nothing below it to push); the perch lives one row above
		// the editor at the bottom of the screen, and cannot. Cells until the
		// terminal answers — the fallback is exact by construction.
		//
		// Short transients (done/error/startled, <~700ms) force the half-block cell
		// path even when sixel is available: each sixel frame full-row-erases the
		// whole perch before redrawing, which flickers badly during hop/shake. Cells
		// repaint in place with no erase choreography — better for brief, big motion.
		const sixel = this.usesSixelTransport();
		if (
			width === this.memoWidth &&
			sixel === this.memoSixel &&
			this.memoParams &&
			samePose(params, this.memoParams) &&
			this.memoColors &&
			sameColors(colors, this.memoColors)
		) {
			return this.renderLines;
		}
		this.memoWidth = width;
		this.memoSixel = sixel;
		this.memoParams = params;
		this.memoColors = colors;
		this.renderLines = sixel
			? this.renderPerchSixel(width, colors, params)
			: this.renderPerchCells(width, colors, params);
		return this.renderLines;
	}

	/**
	 * Sixel perch: `PET_PERCH_SIXEL_ROWS` lines, right-aligned so the pet sits on
	 * the box's top-right corner. The last line carries the image and self-clears
	 * ALL reserved rows before redrawing (DECSC → clear-up → sixel → DECRC), the
	 * exact pattern proven by startup-screen.ts's `buildPetSixelLines`.
	 *
	 * The sprite is sized against {@link PET_PERCH_SIXEL_DRAW_ROWS}, not the full
	 * reservation, so the bottom row stays slack — see the constant for why that
	 * row is load-bearing. The cursor walks up the whole reservation to the block's
	 * top row, and the image falls from there, ending one row short of the row it
	 * was written on.
	 *
	 * The pixel height goes through {@link fitSixelHeightPx} so the drawing is a
	 * whole number of 6px bands: a partial band is rounded UP by terminals that
	 * size an image by its content, which is how a sprite that fits on paper still
	 * overruns its rows in practice.
	 */
	private renderPerchSixel(width: number, colors: PetColors, params: PetParams): string[] {
		const cell = getCellDimensions();
		const heightPx = fitSixelHeightPx(PET_PERCH_SIXEL_DRAW_ROWS * cell.heightPx);
		const widthPx = Math.round(heightPx * PET_PERCH_ASPECT);
		const petCols = Math.ceil(widthPx / Math.max(1, cell.widthPx));
		const leftPad = Math.max(0, width - petCols);
		const sixel = renderPetSixel(widthPx, heightPx, { ...params, colors });

		const lines: string[] = [];
		for (let i = 0; i < PET_PERCH_SIXEL_ROWS - 1; i++) lines.push("");
		// Clear every reserved row (the transparent sprite erases nothing on its
		// own, so a shrinking frame would leave ghosts). EL alone does NOT do it:
		// xterm leaves graphics over an `\x1b[2K`-erased line intact (only ED /
		// whole-line ops / WRITTEN text erase them — see xterm's
		// chararea_clear_displayed_graphics call sites), and with P2=1 the next
		// frame's unwritten pixels keep the PREVIOUS frame's silhouette, so the
		// body animations (bob/tilt/squash) pile poses on top of each other.
		// Painting blank TEXT across the sprite's column span is what actually
		// erases the underlying pixels on xterm, and on cell-attached terminals
		// (foot, WezTerm) the written blanks replace the image cells anyway. The
		// walk up ends on the block's TOP row, which is exactly where the
		// drawing has to start for the slack row to end up at the bottom, under
		// the sprite.
		// Full-row erase + full sprite rewrite every frame is inherent to sixel:
		// terminals do not expose a cheap partial-update path for graphics cells,
		// and transparent P2 keeps previous silhouettes unless we blank the span.
		// Flicker risk is real on slow links; the half-block cell path below is the
		// intentional non-sixel fallback when sixel is unavailable or disabled.
		const eraseRow = `\x1b[2K${" ".repeat(petCols)}\x1b[${petCols}D`;
		const clearAll = `${eraseRow}${`\x1b[1A${eraseRow}`.repeat(PET_PERCH_SIXEL_ROWS - 1)}`;
		lines.push(`${" ".repeat(leftPad)}\x1b7${clearAll}${sixel}\x1b8`);
		return lines;
	}

	/** Half-block cell fallback: a small right-aligned sprite block. */
	private renderPerchCells(width: number, colors: PetColors, params: PetParams): string[] {
		const cols = Math.max(1, Math.min(width, PET_PERCH_CELL_COLS));
		const cells = renderPetCells(cols, PET_PERCH_CELL_ROWS, { ...params, colors });
		const pad = " ".repeat(Math.max(0, width - cols));
		return cells.map((line) => pad + line);
	}
}

export function createPetCompanion(options: PetCompanionOptions): PetCompanion {
	return new PetCompanion(options);
}
