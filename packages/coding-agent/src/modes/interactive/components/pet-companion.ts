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

export interface PetCompanionOptions extends PetMoodOptions {
	/** Resolved pet colors, read fresh each render so a theme switch is picked up. */
	getColors: () => PetColors;
	/** Injectable clock (defaults to performance.now) for the render-time sample. */
	clock?: () => number;
}

export class PetCompanion implements Component {
	private readonly mood: PetMood;
	private readonly getColors: () => PetColors;
	private readonly clock: () => number;
	private readonly reducedMotion: boolean;
	// Dirty-tracking for the ticker: last quantized frame key requested a render for.
	private lastTickKey = "";
	// Render memo: identical (width, mode, params, colors) hands back the same array.
	private renderKey = "";
	private renderLines: string[] = [];
	// Standing user-driven state (draft in the composer or not), independent of what
	// the turn is doing. See setAmbientMood / tick.
	private ambientBaseline: PetMoodState = "idle";

	constructor(options: PetCompanionOptions) {
		this.getColors = options.getColors;
		this.clock = options.clock ?? (() => performance.now());
		this.reducedMotion = options.reducedMotion ?? false;
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
	 * Sample clock for the CURRENT mood, quantized to that mood's repaint cadence
	 * ({@link petFrameIntervalMs}). This is the pet's frame-rate governor: idle
	 * breathing samples ~12×/s while a `done` hop samples ~30×/s, so continuous
	 * motion never costs a sprite re-encode on every 16 ms ticker frame.
	 */
	private sampleAt(now: number): number {
		const step = petFrameIntervalMs(this.mood.current);
		return Math.floor(now / step) * step;
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
		const key = this.frameKey(this.mood.params(this.sampleAt(now)));
		const dirty = stateChanged || key !== this.lastTickKey;
		this.lastTickKey = key;
		return dirty;
	}

	/**
	 * Faithful signature of a frame: two samples differ iff the pose differs.
	 *
	 * This used to round each channel into PIXEL-sized buckets so a sub-pixel
	 * change could not trigger a repaint. The reasoning was sound and the result
	 * was not: idle breathing has an amplitude of ±0.02u ≈ ±1px, so a whole breath
	 * crossed about one bucket. Measured over a simulated 20s at the 16 ms ticker,
	 * that bought **2.5 repaints/s while idle with stalls up to 1.36 s**, and 9.4/s
	 * while thinking — the pet was not animating slowly, it was holding still and
	 * then jumping. The bucket, not the sample cadence, was the frame-rate limiter.
	 *
	 * The rate limiter is now {@link sampleAt} alone, which is what the design
	 * intended: params are evaluated on a clock already quantized to the mood's
	 * cadence, so a moving pose repaints once per sample and no more. The saving
	 * the bucket was protecting is small — a perch sprite encodes in ~0.5 ms, so
	 * even a 60 fps pet costs ~3% of one core, and at these cadences it is ~1%.
	 *
	 * What survives is the property actually worth having: a pose that does NOT
	 * move produces an identical signature, so the render memo holds and nothing is
	 * re-encoded — which is what keeps a reduced-motion pet (params pinned to
	 * `{ blinkK: 1 }`) free. The 4-decimal rounding is float-dust immunity, not
	 * bucketing: at ~48px per canvas unit it resolves 0.005px.
	 */
	private frameKey(p: PetParams): string {
		const q = (v: number | undefined): string => (v ?? 0).toFixed(4);
		return [
			q(p.blinkK),
			q(p.eyeShift),
			q(p.eyeShiftY),
			q(p.eyeScale ?? 1),
			q(p.bobX),
			q(p.bobY),
			q(p.tilt),
			q(p.squash),
		].join(":");
	}

	invalidate(): void {
		this.renderKey = "";
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
		const sixel = getSixelSupport() && areCellDimensionsMeasured();
		const key = `${width}|${sixel ? "s" : "c"}|${this.frameKey(params)}|${colors.stroke.join(",")}|${colors.eye.join(",")}|${colors.bg.join(",")}`;
		if (key === this.renderKey) return this.renderLines;
		this.renderKey = key;
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
