/**
 * Startup (welcome) screen — the pre-conversation identity block.
 *
 * Redesign (2026-07): a centered column reproducing the approved mock — the pet
 * mascot on top (sixel when the terminal supports it, half-block cells
 * otherwise), then a dense identity line (`pit v… · tagline`) and up to three
 * recent sessions (`• title (age)`) under an explicit `/resume` affordance. No horizontal rule, no "Welcome
 * to Pit", and no workspace context line: cwd/branch/model/thinking/mode are
 * already on the pristine footer of the SAME screen (footer.ts collapse), so
 * repeating them here was pure noise — the original welcome-box had cut exactly
 * this duplication once before.
 *
 * Motion (unless {@link StartupScreenData.reducedMotion}): the block reveals one
 * unit at a time (~110 ms apart), the pet blinks once about a second after the
 * reveal settles, then gives a single small glance DOWN toward the editor it is
 * about to perch on. `tick(now)` advances that state from the shared TUI
 * ticker; `isSettled()` lets the host drop the animation subscription. A short
 * window (`rows < COMPACT_ROWS`) drops the big pet and top-anchors a compact
 * block.
 *
 * The differential renderer paints the pet through the same path as inline
 * images: the sixel/cell lines are returned like any other lines, and
 * `isImageLine()` (which now recognizes the sixel DCS introducer) keeps the
 * renderer from measuring or slicing them. The sixel line pins the cursor with
 * DECSC/DECRC so the image draws into the reserved rows without disturbing the
 * renderer's row accounting — no out-of-band painting, so resizes and blinks
 * flow through normal re-renders.
 */

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
	truncateToWidth,
	visibleWidth,
} from "@pit/tui";
import { theme } from "../theme/theme.ts";

/** A resumable recent session surfaced on the welcome. */
export interface StartupRecentSession {
	title: string;
	/** Pre-formatted age, e.g. "2h" or "yesterday". */
	age: string;
}

export interface StartupScreenData {
	appName: string;
	version: string;
	/** Short tagline, e.g. "your coding companion". */
	tagline: string;
	/** Optional dim suffix on the identity line, e.g. "/help". */
	helpHint?: string;
	/** Up to three recent sessions to offer for resume. */
	recentSessions: StartupRecentSession[];
	/** Explicit affordance shown above recent sessions. */
	recentSessionsHint?: string;
	/** Resolved pet colors (stroke/eye/bg) from the theme. */
	petColors: PetColors;
	/** False when `PIT_NO_PET` disables the mascot entirely. */
	petEnabled: boolean;
	/** When true: reveal instantly, no blink. */
	reducedMotion: boolean;
	/** Terminal height, for vertical placement and the compact threshold. */
	rows: number;
}

/** Max column width of the centered block (matches the mock). */
const MAX_COL_WIDTH = 96;
/** Below this height the big pet is dropped and the block top-anchors. */
const COMPACT_ROWS = 20;
/** Sixel pet footprint (rows); width derives from the 2:1 canvas aspect. */
const PET_SIXEL_ROWS = 6;
/**
 * Rows the sprite actually draws into. The reservation keeps one spare row under
 * it so band rounding or a slightly-off cell size overflows into blank space
 * instead of a row the frame does not own — the same slack the composer perch
 * depends on (see pet-companion.ts's PET_PERCH_SIXEL_ROWS for the full why).
 */
const PET_SIXEL_DRAW_ROWS = PET_SIXEL_ROWS - 1;
const PET_ASPECT = 2;
/** Cell-fallback pet footprint. */
const PET_CELL_COLS = 30;
const PET_CELL_ROWS = 8;
/** Bottom breathing room reserved for the editor + footer + hint. */
const BOTTOM_RESERVE = 6;

const REVEAL_MS_PER_UNIT = 110;
const BLINK_DELAY_AFTER_REVEAL_MS = 700;
const BLINK_DURATION_MS = 130;
const BLINK_K_OPEN = 1;
const BLINK_K_CLOSED = 0.08;
/**
 * The settle glance: a beat after the blink reopens, the eyes sweep down toward
 * the editor (positive `eyeShiftY` = down, same convention as PetMood's
 * `watching`) and drift back. One shot, sine-eased, then the screen settles and
 * the host unsubscribes — the hero stays static, going quiet on its own.
 */
const GAZE_DELAY_AFTER_BLINK_MS = 160;
const GAZE_DURATION_MS = 520;
const GAZE_PEAK_Y = 0.05;

function centerLine(line: string, width: number): string {
	const w = visibleWidth(line);
	if (w >= width) return truncateToWidth(line, width, "…");
	return " ".repeat(Math.max(0, Math.floor((width - w) / 2))) + line;
}

export class StartupScreen implements Component {
	private data: StartupScreenData;
	// Reveal/blink state, advanced by tick().
	private startAt: number | null = null;
	private visibleUnits: number;
	private blinkK = BLINK_K_OPEN;
	private blinkDone: boolean;
	// The one-shot down-glance toward the editor, played after the blink.
	private settleGazeY = 0;
	private gazeDone: boolean;
	// Layout plan (width-independent), recomputed on setData().
	private showPet: boolean;
	private unitCount: number;

	constructor(data: StartupScreenData) {
		this.data = data;
		const plan = StartupScreen.plan(data);
		this.showPet = plan.showPet;
		this.unitCount = plan.unitCount;
		this.blinkDone = data.reducedMotion;
		this.gazeDone = data.reducedMotion;
		this.visibleUnits = data.reducedMotion ? this.unitCount : 1;
	}

	/** Width-independent layout facts derived from the data. */
	private static plan(data: StartupScreenData): { showPet: boolean; unitCount: number } {
		const compact = data.rows < COMPACT_ROWS;
		const showPet = data.petEnabled && !compact;
		const resumes = Math.min(3, data.recentSessions.length);
		const unitCount = (showPet ? 1 : 0) + 1 /* identity */ + (resumes > 0 ? 1 : 0) + resumes;
		return { showPet, unitCount };
	}

	setData(data: StartupScreenData): void {
		const prevUnitCount = this.unitCount;
		const revealWasComplete = this.visibleUnits >= prevUnitCount;
		this.data = data;
		const plan = StartupScreen.plan(data);
		this.showPet = plan.showPet;
		this.unitCount = plan.unitCount;
		if (data.reducedMotion) {
			this.visibleUnits = this.unitCount;
			this.blinkDone = true;
			this.gazeDone = true;
		} else if (revealWasComplete) {
			// Late-arriving sessions after the reveal settled: show them at once
			// rather than re-animating the whole block.
			this.visibleUnits = this.unitCount;
		} else {
			this.visibleUnits = Math.min(this.visibleUnits, this.unitCount);
		}
	}

	/** True once the reveal, the single blink and the settle glance have all played. */
	isSettled(): boolean {
		return this.visibleUnits >= this.unitCount && this.blinkDone && this.gazeDone;
	}

	/**
	 * Advance reveal + blink from the shared ticker clock. Returns true when
	 * something visible changed (so the host requests a render).
	 */
	tick(now: number): boolean {
		if (this.data.reducedMotion) {
			return false;
		}
		if (this.startAt === null) this.startAt = now;
		const elapsed = now - this.startAt;

		const newVisible = Math.min(this.unitCount, 1 + Math.floor(elapsed / REVEAL_MS_PER_UNIT));
		const revealDoneMs = Math.max(0, this.unitCount - 1) * REVEAL_MS_PER_UNIT;
		const blinkStart = revealDoneMs + BLINK_DELAY_AFTER_REVEAL_MS;

		let newBlink = BLINK_K_OPEN;
		if (!this.blinkDone) {
			if (elapsed >= blinkStart && elapsed < blinkStart + BLINK_DURATION_MS) {
				newBlink = BLINK_K_CLOSED;
			} else if (elapsed >= blinkStart + BLINK_DURATION_MS) {
				this.blinkDone = true;
			}
		}

		let newGaze = 0;
		if (this.blinkDone && !this.gazeDone) {
			const p = (elapsed - (blinkStart + BLINK_DURATION_MS + GAZE_DELAY_AFTER_BLINK_MS)) / GAZE_DURATION_MS;
			if (p >= 1) {
				this.gazeDone = true;
			} else if (p > 0) {
				newGaze = Math.sin(p * Math.PI) * GAZE_PEAK_Y;
			}
		}

		const dirty = newVisible !== this.visibleUnits || newBlink !== this.blinkK || newGaze !== this.settleGazeY;
		this.visibleUnits = newVisible;
		this.blinkK = newBlink;
		this.settleGazeY = newGaze;
		return dirty;
	}

	invalidate(): void {
		// Rendering reads live from `data` + reveal state each frame; nothing cached.
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		try {
			return this.renderCore(safeWidth);
		} catch {
			// Never let a welcome-screen glitch take down the session.
			return [theme.fg("warning", "Startup screen unavailable")];
		}
	}

	private renderCore(width: number): string[] {
		const colWidth = Math.min(width, MAX_COL_WIDTH);
		const d = this.data;

		const units: string[][] = [];
		if (this.showPet) {
			units.push(this.buildPetUnit(width));
		}
		// A blank separates the pet from the identity; without a pet the identity
		// is the first line (compact/top-anchored — no leading gap).
		const identityLine = this.buildIdentityLine(colWidth, width);
		units.push(this.showPet ? ["", identityLine] : [identityLine]);
		const resumes = d.recentSessions.slice(0, 3);
		if (resumes.length > 0) {
			units.push([this.buildRecentSessionsHint(colWidth, width)]);
		}
		resumes.forEach((s, i) => {
			const line = this.buildResumeLine(s, colWidth, width);
			units.push(i === 0 ? ["", line] : [line]);
		});

		// Vertical placement: compute the full block height, then push it down
		// toward ~1/2.4 of the viewport (mock rhythm), clamped so the editor below
		// stays on screen. Compact windows top-anchor.
		const fullHeight = units.reduce((n, u) => n + u.length, 0);
		const compact = d.rows < COMPACT_ROWS;
		let topPad = 0;
		if (!compact) {
			const avail = Math.max(0, d.rows - fullHeight - BOTTOM_RESERVE);
			const target = Math.floor((d.rows - fullHeight) / 2.4);
			topPad = Math.max(0, Math.min(target, avail));
		}

		const out: string[] = [];
		for (let i = 0; i < topPad; i++) out.push("");
		const visible = Math.max(1, Math.min(units.length, this.visibleUnits));
		for (let i = 0; i < visible; i++) {
			out.push(...units[i]!);
		}
		return out;
	}

	/** The identity line: `pit v… · tagline` (+ optional dim `/help`). */
	private buildIdentityLine(colWidth: number, width: number): string {
		const d = this.data;
		const brand = theme.bold(theme.fg("text", d.appName));
		let meta = ` v${d.version} · ${d.tagline}`;
		if (d.helpHint) meta += ` · ${d.helpHint}`;
		const line = `${brand}${theme.fg("dim", meta)}`;
		return centerLine(truncateToWidth(line, colWidth, "…"), width);
	}

	/** A recent-session line: `• title (age)`. */
	private buildResumeLine(session: StartupRecentSession, colWidth: number, width: number): string {
		const marker = theme.fg("muted", "•");
		const body = theme.fg("muted", `${session.title} (${session.age})`);
		const line = `${marker} ${body}`;
		return centerLine(truncateToWidth(line, colWidth, "…"), width);
	}

	private buildRecentSessionsHint(colWidth: number, width: number): string {
		const hint = theme.fg("muted", this.data.recentSessionsHint ?? "Recent sessions · /resume");
		return centerLine(truncateToWidth(hint, colWidth, "…"), width);
	}

	/**
	 * Build the pet block (already left-padded to center). Sixel when supported
	 * AND the terminal has reported its cell size, half-block cells otherwise.
	 * Returns a fixed number of lines so the reveal below it stays put.
	 *
	 * The cell-size condition is what keeps the sprite inside its reservation: its
	 * height is authored in rows and emitted in pixels, so an unmeasured cell turns
	 * that conversion into a guess that can draw over rows this block does not own.
	 */
	private buildPetUnit(width: number): string[] {
		const colors = this.data.petColors;
		const params: PetParams = { blinkK: this.blinkK, eyeShiftY: this.settleGazeY };
		if (getSixelSupport() && areCellDimensionsMeasured()) {
			return this.buildPetSixelLines(width, colors, params);
		}
		return this.buildPetCellLines(width, colors, params);
	}

	private buildPetCellLines(width: number, colors: PetColors, params: PetParams): string[] {
		const cols = Math.min(width, PET_CELL_COLS);
		const cells = renderPetCells(cols, PET_CELL_ROWS, { ...params, colors });
		const pad = " ".repeat(Math.max(0, Math.floor((width - cols) / 2)));
		return cells.map((line) => pad + line);
	}

	/**
	 * Sixel pet as `PET_CELL_ROWS` lines — the SAME height the cell fallback
	 * renders, so the unit never changes size when the sprite flips modes
	 * mid-session (the cell-size answer lands asynchronously, usually right as
	 * the welcome paints; an 8→6 line swap re-anchored the whole reveal). The
	 * drawing keeps its smaller `PET_SIXEL_ROWS` reservation bottom-anchored:
	 * `PET_CELL_ROWS - 1` blank rows plus a final line carrying the image. That
	 * last line, when the renderer rewrites it (blink), self-clears ALL reserved
	 * rows before redrawing:
	 *
	 *   ESC 7            save cursor at the bottom row (its own row)
	 *   per row:         ESC[2K + paint petCols blanks + CUB back (see below)
	 *   (ESC[1A …)×      walk up clearing every reserved row → cursor at top row
	 *   <sixel>          draw the transparent image downward from the top row
	 *   ESC 8            restore to the bottom row
	 *
	 * The self-clear matters because a transparent sixel does not erase pixels it
	 * does not touch; without clearing, a shrinking-eye blink would leave ghosts in
	 * the rows above (the differential renderer only clears the one line it
	 * rewrites). And EL alone does NOT clear: xterm keeps graphics displayed over
	 * an `\x1b[2K`-erased line (only ED, whole-line ops, or WRITTEN text erase
	 * them), and with P2=1 the next frame's untouched pixels keep the PREVIOUS
	 * frame's silhouette — the poses would accumulate. Painting blank text across
	 * the sprite's column span erases the underlying pixels on xterm, and on
	 * cell-attached terminals (foot, WezTerm) the written blanks replace the
	 * image cells outright. DECSC/DECRC also pin the cursor to the bottom row so
	 * the renderer's row accounting stays exact regardless of sixel scrolling
	 * mode — which holds as long as the drawing stays inside the reservation,
	 * hence the spare row {@link PET_SIXEL_DRAW_ROWS} leaves at the bottom, and
	 * the band quantization {@link fitSixelHeightPx} applies so the last band is
	 * never a partial one a terminal would round up into the row below.
	 */
	private buildPetSixelLines(width: number, colors: PetColors, params: PetParams): string[] {
		const cell = getCellDimensions();
		const heightPx = fitSixelHeightPx(PET_SIXEL_DRAW_ROWS * cell.heightPx);
		const widthPx = Math.round(heightPx * PET_ASPECT);
		const petCols = Math.ceil(widthPx / Math.max(1, cell.widthPx));
		const leftPad = Math.max(0, Math.floor((width - petCols) / 2));
		const sixel = renderPetSixel(widthPx, heightPx, { ...params, colors });

		const lines: string[] = [];
		// Leading blanks pad the unit out to PET_CELL_ROWS (the cell fallback's
		// height — the mode-switch invariant), with the sprite's own reservation
		// anchored at the bottom where it always was.
		for (let i = 0; i < PET_CELL_ROWS - 1; i++) lines.push("");
		const eraseRow = `\x1b[2K${" ".repeat(petCols)}\x1b[${petCols}D`;
		const clearUp = `${eraseRow}${`\x1b[1A${eraseRow}`.repeat(PET_SIXEL_ROWS - 1)}`;
		lines.push(`${" ".repeat(leftPad)}\x1b7${clearUp}${sixel}\x1b8`);
		return lines;
	}
}
