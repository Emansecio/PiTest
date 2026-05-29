import type { TUI } from "../tui.ts";
import { Text } from "./text.ts";

export interface LoaderIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

const DEFAULT_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"];
const DEFAULT_INTERVAL_MS = 100;

/**
 * Animation frames per palette-phase step. The color pulse advances one phase
 * every this-many spinner frames, so at the default 100ms frame the pulse
 * breathes at ~300ms/phase instead of being tied to the (8-frame, ~800ms) spinner
 * cycle — fast enough to read as a live pulse, slow enough to stay gentle.
 */
const PULSE_FRAMES_PER_PHASE = 3;

/**
 * Loader component that updates with an optional spinning animation.
 */
export type LoaderColorFn = (str: string) => string;

export class Loader extends Text {
	// Shared across every Loader so consecutive instances resume mid-cycle
	// instead of snapping back to frame 0. Updated on each visible tick.
	private static lastFrame = 0;

	private frames = [...DEFAULT_FRAMES];
	private intervalMs = DEFAULT_INTERVAL_MS;
	private currentFrame = Loader.lastFrame;
	private intervalId: NodeJS.Timeout | null = null;
	private ui: TUI | null = null;
	private renderIndicatorVerbatim = false;
	private spinnerPalette: LoaderColorFn[];
	private messageColorFn: LoaderColorFn;

	// Pre-computed once per setIndicator()/setMessage() so the hot interval
	// callback never calls into the color functions or re-allocates strings
	// beyond the final concatenation.
	private coloredFrames: string[][] = [[]];
	private coloredMessage: string = "";
	private paletteIndex = 0;
	// Counts spinner frames to drive the palette phase independently of the
	// spinner-frame cycle (see PULSE_FRAMES_PER_PHASE).
	private pulseTick = 0;

	// Optional elapsed-time suffix (e.g. "Working… 14s"). Opt-in via
	// setElapsedEnabled() — used by the interactive "working" loader so a long
	// turn visibly counts up. Origin is captured when enabled; for the working
	// loader that is the per-turn agent_start (a fresh Loader is built then), so
	// the counter measures the whole turn. The suffix string is rebuilt at most
	// once per second (gated on the integer second), not on every spinner tick,
	// and rides the existing 100ms animation interval so it adds no extra renders.
	private elapsedEnabled = false;
	private startedAtMs = 0;
	private lastElapsedSec = -1;
	private coloredElapsed = "";

	constructor(
		ui: TUI,
		spinnerColor: LoaderColorFn | LoaderColorFn[],
		messageColorFn: LoaderColorFn,
		message: string = "Loading...",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		const palette = Array.isArray(spinnerColor) ? spinnerColor.slice() : [spinnerColor];
		this.spinnerPalette = palette.length > 0 ? palette : [(s) => s];
		this.messageColorFn = messageColorFn;

		this.coloredMessage = messageColorFn(message);
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		return ["", ...super.render(width)];
	}

	start(): void {
		this.updateDisplay();
		this.restartAnimation();
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	setMessage(message: string): void {
		this.coloredMessage = this.messageColorFn(message);
		this.updateDisplay();
	}

	/**
	 * Toggle the elapsed-time suffix. When enabled, the loader appends a compact
	 * counter (`3s`, `2m05s`, `1h03m`) to the message, refreshed once per second.
	 * Enabling (re)starts the clock from now; disabling clears the suffix.
	 */
	setElapsedEnabled(enabled: boolean): void {
		if (enabled === this.elapsedEnabled) return;
		this.elapsedEnabled = enabled;
		if (enabled) {
			this.startedAtMs = Date.now();
		}
		this.lastElapsedSec = -1;
		this.coloredElapsed = "";
		this.updateDisplay();
	}

	private static formatElapsed(totalSec: number): string {
		if (totalSec < 60) return `${totalSec}s`;
		if (totalSec < 3600) {
			const m = Math.floor(totalSec / 60);
			const s = totalSec % 60;
			return `${m}m${s.toString().padStart(2, "0")}s`;
		}
		const h = Math.floor(totalSec / 3600);
		const m = Math.floor((totalSec % 3600) / 60);
		return `${h}h${m.toString().padStart(2, "0")}m`;
	}

	/**
	 * Recompute the elapsed suffix, but only rebuild the (colored) string when the
	 * whole-second value actually changes. Called on every animation tick; the
	 * second-gate keeps it allocation-free for ~9 of every 10 ticks.
	 */
	private refreshElapsed(): void {
		if (!this.elapsedEnabled) {
			if (this.coloredElapsed !== "") this.coloredElapsed = "";
			return;
		}
		const sec = Math.floor((Date.now() - this.startedAtMs) / 1000);
		if (sec === this.lastElapsedSec) return;
		this.lastElapsedSec = sec;
		// Hide the first second so the counter doesn't flash "0s" at turn start.
		this.coloredElapsed = sec > 0 ? this.messageColorFn(` ${Loader.formatElapsed(sec)}`) : "";
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : DEFAULT_INTERVAL_MS;
		this.currentFrame = Loader.lastFrame % Math.max(1, this.frames.length);
		this.paletteIndex = 0;
		this.recolorFrames();
		this.start();
	}

	private recolorFrames(): void {
		if (this.renderIndicatorVerbatim) {
			// Custom indicator frames already carry their own ANSI; render verbatim.
			this.coloredFrames = [this.frames.slice()];
			return;
		}
		this.coloredFrames = this.spinnerPalette.map((fn) => this.frames.map((f) => fn(f)));
	}

	private restartAnimation(): void {
		this.stop();
		if (this.frames.length <= 1) {
			return;
		}
		this.pulseTick = 0;
		this.intervalId = setInterval(() => this.advanceFrame(), this.intervalMs);
	}

	/** One animation step: advance the spinner frame, pulse the palette phase
	 * every PULSE_FRAMES_PER_PHASE frames (steady cadence, decoupled from the
	 * spinner cycle length), and repaint. */
	private advanceFrame(): void {
		this.currentFrame = (this.currentFrame + 1) % this.frames.length;
		this.pulseTick++;
		if (this.pulseTick % PULSE_FRAMES_PER_PHASE === 0 && this.coloredFrames.length > 1) {
			this.paletteIndex = (this.paletteIndex + 1) % this.coloredFrames.length;
		}
		this.updateDisplay();
	}

	private updateDisplay(): void {
		const rawFrame = this.frames[this.currentFrame] ?? "";
		const paletteRow = this.coloredFrames[this.paletteIndex] ?? this.coloredFrames[0] ?? [];
		const renderedFrame = paletteRow[this.currentFrame] ?? rawFrame;
		const indicator = rawFrame.length > 0 ? `${renderedFrame} ` : "";
		this.refreshElapsed();
		this.setText(`${indicator}${this.coloredMessage}${this.coloredElapsed}`);
		Loader.lastFrame = this.currentFrame;
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
