import type { TUI } from "@pit/tui";
import { isReducedMotion } from "../../../utils/env-flags.ts";
import { interpolateFg } from "../theme/color-interpolation.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

/** Matches the gutter ease (tool-execution.ts) so all state-icon settles share
 * one cadence. */
export const COLOR_EASE_MS = 180;

/** Probe glyph for dirty detection — must be a single visible cell. */
const PROBE_GLYPH = "█";

/**
 * Drives a one-shot foreground color transition for a single glyph/label,
 * mirroring ToolExecutionComponent's gutterEaseTick: smoothstep over
 * COLOR_EASE_MS via interpolateFg, self-stopping on completion. Snaps instantly
 * when truecolor easing is unavailable (256-color / test env), so callers always
 * end on the steady theme color and never animate where they can't.
 *
 * The owning component asks `colorize(steady, text)` each frame: while an ease is
 * in flight it returns the blended color, otherwise the steady theme color.
 *
 * Animation ticks return dirty only when the blended probe or the progress half
 * (0 vs 1, for spinner→✓ crossfade) changes — `onFrame` runs on snap only.
 */
export class ColorEase {
	private ui: TUI;
	private onFrame: () => void;
	private from: ThemeColor = "dim";
	private to: ThemeColor | null = null;
	private startAt = 0;
	private eased = 1;
	private unsub: (() => void) | null = null;
	private lastProbe = "";

	constructor(ui: TUI, onFrame: () => void) {
		this.ui = ui;
		this.onFrame = onFrame;
	}

	get active(): boolean {
		return this.unsub !== null;
	}

	/** Eased progress 0→1 of the in-flight transition (smoothstep); 1 when settled.
	 * Lets a caller stage a two-phase settle (e.g. hold one glyph through the first
	 * half, swap on the second) against this same shared ease. */
	get progress(): number {
		return this.unsub !== null ? this.eased : 1;
	}

	/** Begin easing `from` → `to`. No-op-animates (snaps) without truecolor. */
	begin(from: ThemeColor, to: ThemeColor): void {
		this.stop();
		this.to = to;
		// No truecolor easing available, or motion suppressed (reduced-motion):
		// settle on the steady color without registering an animation callback.
		if (isReducedMotion() || !interpolateFg(from, to, 0)) {
			this.onFrame();
			return;
		}
		this.from = from;
		this.eased = 0;
		this.lastProbe = "";
		this.startAt = performance.now();
		this.unsub = this.ui.addAnimationCallback((now) => this.tick(now));
	}

	private blendProbe(): string {
		if (!this.unsub || !this.to) return "";
		const blend = interpolateFg(this.from, this.to, this.eased);
		if (blend) return blend(PROBE_GLYPH);
		return theme.fg(this.to, PROBE_GLYPH);
	}

	private tick(now: number): boolean {
		const raw = (now - this.startAt) / COLOR_EASE_MS;
		const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
		const prevHalf = this.eased < 0.5 ? 0 : 1;
		const newEased = t * t * (3 - 2 * t); // smoothstep
		const newHalf = newEased < 0.5 ? 0 : 1;
		this.eased = newEased;
		const probe = this.blendProbe();
		const dirty = probe !== this.lastProbe || newHalf !== prevHalf;
		if (t >= 1) {
			if (dirty) this.lastProbe = probe;
			this.stop();
			return dirty;
		}
		if (!dirty) return false;
		this.lastProbe = probe;
		return true;
	}

	stop(): void {
		if (this.unsub) {
			this.unsub();
			this.unsub = null;
		}
		this.eased = 1;
		this.lastProbe = "";
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
