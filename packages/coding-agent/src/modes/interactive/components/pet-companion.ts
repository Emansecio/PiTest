/**
 * PetCompanion — the mid-conversation mascot that perches to the right of the
 * input editor. A tiny half-block render of the shared pet geometry
 * ({@link @pit/tui} `renderPetCells`) whose eyes animate with the agent's mood
 * ({@link PetMood}).
 *
 * WHY CELLS, NOT SIXEL: the companion shares terminal rows with the editor
 * frame (they are composited side-by-side by {@link ComposerChrome}). A sixel
 * DCS anywhere on a line makes the renderer treat the WHOLE line as an image
 * (`isImageLine`), which would break the editor half of that row (no width
 * measuring, no cell diff). Half-block cells are ordinary colored text: they
 * composite beside the editor and diff cleanly. The editor region is also
 * repainted every frame and never scrolls into history, so — unlike a pinned
 * body overlay — there is no ghosting to design around.
 *
 * The component memoizes its rendered lines by (width, quantized params,
 * colors) so a frame where nothing about the pet changed hands back the SAME
 * array reference, letting the ComposerChrome cache hit while the pet sits idle.
 */

import { performance } from "node:perf_hooks";
import { type Component, type PetColors, type PetParams, renderPetCells } from "@pit/tui";
import { PetMood, type PetMoodOptions, type PetMoodState } from "./pet-mood.ts";

/** Half-block width of the mascot (cells). */
export const PET_COMPANION_COLS = 12;
/** Height of the mascot in rows — matches a single-line editor's framed height. */
export const PET_COMPANION_ROWS = 3;
/** Breathing space between the editor's right border and the pet. */
export const PET_COMPANION_GAP = 2;
/** Total columns the companion reserves beside the editor (pet + gap). */
export const PET_COMPANION_FOOTPRINT = PET_COMPANION_COLS + PET_COMPANION_GAP;
/** Below this terminal width the companion hides and the editor reclaims the space. */
export const PET_COMPANION_MIN_COLS = 100;

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
	// Render memo: identical (width, params, colors) hands back the same array.
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
		const cols = Math.max(1, Math.min(width, PET_COMPANION_COLS));
		const params = this.mood.params(this.clock());
		const colors = this.getColors();
		const key = `${cols}|${this.frameKey(params)}|${colors.stroke.join(",")}|${colors.eye.join(",")}|${colors.bg.join(",")}`;
		if (key === this.renderKey) return this.renderLines;
		this.renderKey = key;
		this.renderLines = renderPetCells(cols, PET_COMPANION_ROWS, {
			blinkK: params.blinkK,
			eyeShift: params.eyeShift,
			colors,
		});
		return this.renderLines;
	}
}

export function createPetCompanion(options: PetCompanionOptions): PetCompanion {
	return new PetCompanion(options);
}
