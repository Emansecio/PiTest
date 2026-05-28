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
		this.intervalId = setInterval(() => {
			this.currentFrame = (this.currentFrame + 1) % this.frames.length;
			// Advance palette phase once per full frame cycle for a gentle pulse.
			if (this.currentFrame === 0 && this.coloredFrames.length > 1) {
				this.paletteIndex = (this.paletteIndex + 1) % this.coloredFrames.length;
			}
			this.updateDisplay();
		}, this.intervalMs);
	}

	private updateDisplay(): void {
		const rawFrame = this.frames[this.currentFrame] ?? "";
		const paletteRow = this.coloredFrames[this.paletteIndex] ?? this.coloredFrames[0] ?? [];
		const renderedFrame = paletteRow[this.currentFrame] ?? rawFrame;
		const indicator = rawFrame.length > 0 ? `${renderedFrame} ` : "";
		this.setText(`${indicator}${this.coloredMessage}`);
		Loader.lastFrame = this.currentFrame;
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
