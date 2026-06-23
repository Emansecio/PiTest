import type { TUI } from "@pit/tui";
import { interpolateFg } from "../theme/color-interpolation.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

/** Matches the gutter ease (tool-execution.ts) so all state-icon settles share
 * one cadence. */
const COLOR_EASE_MS = 180;

/**
 * Drives a one-shot foreground color transition for a single glyph/label,
 * mirroring ToolExecutionComponent's gutterEaseTick: smoothstep over
 * COLOR_EASE_MS via interpolateFg, self-stopping on completion. Snaps instantly
 * when truecolor easing is unavailable (256-color / test env), so callers always
 * end on the steady theme color and never animate where they can't.
 *
 * The owning component asks `colorize(steady, text)` each frame: while an ease is
 * in flight it returns the blended color, otherwise the steady theme color.
 */
export class ColorEase {
	private ui: TUI;
	private onFrame: () => void;
	private from: ThemeColor = "dim";
	private to: ThemeColor | null = null;
	private startAt = 0;
	private eased = 1;
	private unsub: (() => void) | null = null;

	constructor(ui: TUI, onFrame: () => void) {
		this.ui = ui;
		this.onFrame = onFrame;
	}

	get active(): boolean {
		return this.unsub !== null;
	}

	/** Begin easing `from` → `to`. No-op-animates (snaps) without truecolor. */
	begin(from: ThemeColor, to: ThemeColor): void {
		this.stop();
		this.to = to;
		// No truecolor easing available: leave it to the steady color.
		if (!interpolateFg(from, to, 0)) {
			this.onFrame();
			return;
		}
		this.from = from;
		this.eased = 0;
		this.startAt = performance.now();
		this.unsub = this.ui.addAnimationCallback((now) => this.tick(now));
	}

	private tick(now: number): boolean {
		const raw = (now - this.startAt) / COLOR_EASE_MS;
		const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
		this.eased = t * t * (3 - 2 * t); // smoothstep
		this.onFrame();
		if (t >= 1) this.stop();
		return true;
	}

	stop(): void {
		if (this.unsub) {
			this.unsub();
			this.unsub = null;
		}
		this.eased = 1;
	}

	/** Color `text`: blended while easing, else the steady color. */
	colorize(steady: ThemeColor, text: string): string {
		if (this.unsub && this.to) {
			const blend = interpolateFg(this.from, this.to, this.eased);
			if (blend) return blend(text);
		}
		return theme.fg(steady, text);
	}
}
