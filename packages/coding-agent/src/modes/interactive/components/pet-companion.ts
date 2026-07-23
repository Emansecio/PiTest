/**
 * PetCompanion — the mid-conversation mascot that perches on its OWN rows
 * directly above the input editor, aligned to the right edge ("perched" on the
 * composer box). Its eyes animate with the agent's mood ({@link PetMood}).
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
 * Moods/state machine ({@link PetMood}) are untouched; only the sprite's
 * placement and renderer changed.
 *
 * The component memoizes its rendered lines by (width, sixel-vs-cell, quantized
 * params, colors) so a frame where nothing about the pet changed hands back the
 * SAME array reference, letting the ComposerChrome cache hit while the pet idles.
 */

import { performance } from "node:perf_hooks";
import {
	type Component,
	getCellDimensions,
	getSixelSupport,
	type PetColors,
	type PetParams,
	renderPetCells,
	renderPetSixel,
} from "@pit/tui";
import { PetMood, type PetMoodOptions, type PetMoodState } from "./pet-mood.ts";

/** Below this terminal width the perch hides and the editor keeps the full width. */
export const PET_COMPANION_MIN_COLS = 100;

/** Reserved rows for the sixel perch; pixel height derives from the cell size. */
export const PET_PERCH_SIXEL_ROWS = 3;
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
	 * Shared-ticker hook (mirrors StartupScreen.tick). Advances transient moods
	 * and reports whether the pet's appearance changed enough to warrant a
	 * repaint — quantized so a continuous sweep repaints at a sane cadence rather
	 * than every 16 ms animation frame. No-op under reduced motion.
	 */
	tick(now: number): boolean {
		if (this.reducedMotion) return false;
		const stateChanged = this.mood.tick(now);
		const key = this.frameKey(this.mood.params(now));
		const dirty = stateChanged || key !== this.lastTickKey;
		this.lastTickKey = key;
		return dirty;
	}

	private frameKey(p: PetParams): string {
		return `${Math.round(p.blinkK * 100)}:${Math.round((p.eyeShift ?? 0) * 100)}`;
	}

	invalidate(): void {
		this.renderKey = "";
	}

	render(width: number): string[] {
		const params = this.mood.params(this.clock());
		const colors = this.getColors();
		const sixel = getSixelSupport();
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
	 */
	private renderPerchSixel(width: number, colors: PetColors, params: PetParams): string[] {
		const cell = getCellDimensions();
		const heightPx = PET_PERCH_SIXEL_ROWS * cell.heightPx;
		const widthPx = Math.round(heightPx * PET_PERCH_ASPECT);
		const petCols = Math.ceil(widthPx / Math.max(1, cell.widthPx));
		const leftPad = Math.max(0, width - petCols);
		const sixel = renderPetSixel(widthPx, heightPx, { blinkK: params.blinkK, eyeShift: params.eyeShift, colors });

		const lines: string[] = [];
		for (let i = 0; i < PET_PERCH_SIXEL_ROWS - 1; i++) lines.push("");
		const clearUp = "\x1b[1A\x1b[2K".repeat(PET_PERCH_SIXEL_ROWS - 1);
		lines.push(`${" ".repeat(leftPad)}\x1b7\x1b[2K${clearUp}${sixel}\x1b8`);
		return lines;
	}

	/** Half-block cell fallback: a small right-aligned sprite block. */
	private renderPerchCells(width: number, colors: PetColors, params: PetParams): string[] {
		const cols = Math.max(1, Math.min(width, PET_PERCH_CELL_COLS));
		const cells = renderPetCells(cols, PET_PERCH_CELL_ROWS, {
			blinkK: params.blinkK,
			eyeShift: params.eyeShift,
			colors,
		});
		const pad = " ".repeat(Math.max(0, width - cols));
		return cells.map((line) => pad + line);
	}
}

export function createPetCompanion(options: PetCompanionOptions): PetCompanion {
	return new PetCompanion(options);
}
