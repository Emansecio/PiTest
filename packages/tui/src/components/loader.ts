import { performance } from "node:perf_hooks";
import type { TUI } from "../tui.ts";
import { Text } from "./text.ts";

export interface LoaderIndicatorOptions {
	/** Animation frames. Use an empty array to hide the indicator. */
	frames?: string[];
	/** Frame interval in milliseconds for animated indicators. */
	intervalMs?: number;
}

/**
 * Canonical spinner frames shared by every live-activity spinner in the UI —
 * the working/bash loader, the tool gutter, and the todo overlay all animate
 * with this one glyph set, so the whole interface reads as a single spinner
 * identity rather than three unrelated ones. Pairs with SPINNER_FRAME_MS.
 */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const DEFAULT_FRAMES: string[] = [...SPINNER_FRAMES];

/**
 * Unified spinner frame cadence (ms). Every live-activity spinner in the UI —
 * the working loader, the tool gutter, the todo overlay, and the goal footer —
 * advances one frame per SPINNER_FRAME_MS off the *same* shared monotonic clock
 * (`performance.now()` via the animation ticker). Sharing one interval keeps
 * them phase-locked, instead of beating against each other at mixed rates that
 * read as several different clocks on screen (P7).
 */
export const SPINNER_FRAME_MS = 80;
const DEFAULT_INTERVAL_MS = SPINNER_FRAME_MS;

/**
 * Unified heartbeat cycle (ms) for every decorative "breathing" oscillation in
 * the UI — the spinner color pulse here and the assistant "Thinking…" label
 * breath (see assistant-message.ts, which imports this). Every breath derives
 * its phase from the *same* shared monotonic clock, so pinning them to one cycle
 * length makes them rise and fall in lockstep instead of drifting against each
 * other. ~1.8s is long enough to read as breathing, short enough to register as
 * live.
 */
export const HEARTBEAT_CYCLE_MS = 1800;

/**
 * Full breath cycle (ms) for the spinner color pulse. The palette is swept once
 * per cycle no matter how many phases it has, so a finer palette (e.g. the
 * truecolor breathing gradient) reads as smoother rather than slower. Aliased to
 * the shared {@link HEARTBEAT_CYCLE_MS} so the spinner pulse and the "Thinking…"
 * label breathe on one heartbeat.
 */
const PULSE_CYCLE_MS = HEARTBEAT_CYCLE_MS;

/**
 * Loader component that updates with an optional spinning animation.
 */
export type LoaderColorFn = (str: string) => string;

export class Loader extends Text {
	private frames = [...DEFAULT_FRAMES];
	private intervalMs = DEFAULT_INTERVAL_MS;
	// Frame + pulse phase are derived from the shared monotonic clock (see
	// tick()), so every Loader shows the same frame at the same instant and a new
	// instance resumes mid-cycle instead of snapping back to frame 0.
	private currentFrame = 0;
	private animationUnsub: (() => void) | null = null;
	private ui: TUI | null = null;
	private renderIndicatorVerbatim = false;
	private spinnerPalette: LoaderColorFn[];
	private messageColorFn: LoaderColorFn;
	// Raw (uncolored) message text, kept so a time-aware color fn can repaint the
	// label from scratch each frame (see setMessageColorAt / refreshMessageColor).
	private message: string;
	// Optional time-aware label color: when set, the message label is recolored
	// every animation frame from `(text, now)` instead of the static messageColorFn.
	// Backward compatible — null by default, so existing static callers are unchanged.
	private messageColorAtFn: ((text: string, now: number) => string) | null = null;

	// Pre-computed once per setIndicator()/setMessage() so the hot tick callback
	// never calls into the color functions or re-allocates strings beyond the
	// final concatenation.
	private coloredFrames: string[][] = [[]];
	private coloredMessage: string = "";
	private paletteIndex = 0;
	// Last string handed to setText(); lets tick() report whether the visible
	// output actually changed so the shared ticker coalesces renders.
	private lastDisplayText = "";

	// Optional elapsed-time suffix (e.g. "Working… 14s"). Opt-in via
	// setElapsedEnabled() — used by the interactive "working" loader so a long
	// turn visibly counts up. Origin is captured when enabled; for the working
	// loader that is the per-turn agent_start (a fresh Loader is built then), so
	// the counter measures the whole turn. The suffix string is rebuilt at most
	// once per second (gated on the integer second), not on every spinner tick,
	// and rides the shared animation ticker so it adds no extra renders.
	private elapsedEnabled = false;
	private startedAtMs = 0;
	private lastElapsedSec = -1;
	private coloredElapsed = "";
	private coloredTrailingSuffix = "";
	// When the turn blocks on the user (e.g. an `ask` picker is open), the clock
	// is frozen rather than left running — the agent is waiting, not working, so
	// counting that interval would misreport effort and pressure the user. The
	// paused span is discounted from startedAtMs on resume, so the counter picks
	// up exactly where it froze.
	private elapsedPaused = false;
	private pausedAtMs = 0;

	// Optional detail segment rendered between the message and the elapsed
	// counter (e.g. a live "…tail of what's happening now" fragment). Distinct
	// from `coloredTrailingSuffix`, which renders after the elapsed counter —
	// this segment sits closer to the phase label. See setDetailSuffix().
	private coloredDetailSuffix = "";

	// Wraps the inner Text's rendered lines with a leading blank line. The
	// loader stays visible for the whole streaming turn, so re-allocating this
	// wrapper array every frame — even when the inner Text returned its cached
	// array unchanged — would force the root Container to re-flatten the whole
	// transcript each frame (see Component.render's memoization contract in
	// tui.ts). Cache the wrapper keyed on the inner array's *reference*: as long
	// as Text.render(width) keeps returning the same instance, hand back the
	// same wrapped instance too.
	private wrappedInnerRef: string[] | null = null;
	private wrappedLines: string[] | null = null;

	constructor(
		ui: TUI,
		spinnerColor: LoaderColorFn | LoaderColorFn[],
		messageColorFn: LoaderColorFn,
		message: string = "Loading…",
		indicator?: LoaderIndicatorOptions,
	) {
		super("", 1, 0);
		this.ui = ui;
		const palette = Array.isArray(spinnerColor) ? spinnerColor.slice() : [spinnerColor];
		this.spinnerPalette = palette.length > 0 ? palette : [(s) => s];
		this.messageColorFn = messageColorFn;

		this.message = message;
		this.coloredMessage = messageColorFn(message);
		this.setIndicator(indicator);
	}

	render(width: number): string[] {
		const inner = super.render(width);
		if (this.wrappedLines !== null && this.wrappedInnerRef === inner) {
			return this.wrappedLines;
		}
		const wrapped = ["", ...inner];
		this.wrappedInnerRef = inner;
		this.wrappedLines = wrapped;
		return wrapped;
	}

	invalidate(): void {
		super.invalidate();
		this.wrappedInnerRef = null;
		this.wrappedLines = null;
	}

	start(): void {
		this.seedFrameFromClock();
		this.updateDisplay();
		this.subscribeAnimation();
	}

	stop(): void {
		this.unsubscribeAnimation();
	}

	setMessage(message: string): void {
		this.message = message;
		this.coloredMessage = this.messageColorAtFn
			? this.messageColorAtFn(message, performance.now())
			: this.messageColorFn(message);
		this.updateDisplay();
	}

	/**
	 * Opt into a time-aware label color: `fn(text, now)` is called every animation
	 * frame to repaint the message label (e.g. a shimmer that sweeps across the
	 * text). Distinct from the static `messageColorFn` passed to the constructor,
	 * which still colors the elapsed counter and trailing suffix. Setting this
	 * ensures the shared ticker is subscribed even for a single frozen indicator
	 * frame, and invalidates the memoized label so the next frame repaints.
	 */
	setMessageColorAt(fn: (text: string, now: number) => string): void {
		this.messageColorAtFn = fn;
		this.coloredMessage = fn(this.message, performance.now());
		this.subscribeAnimation();
		this.updateDisplay();
	}

	setTrailingSuffix(suffix: string): void {
		const next = suffix.length > 0 ? this.messageColorFn(suffix) : "";
		if (next === this.coloredTrailingSuffix) return;
		this.coloredTrailingSuffix = next;
		this.updateDisplay();
	}

	/**
	 * Set an optional detail segment rendered between the message and the
	 * elapsed counter — e.g. a live preview of what the underlying process is
	 * doing right now. Same coloring convention as {@link setTrailingSuffix}
	 * (pass an already-ANSI-colored string if a caller needs a color other than
	 * `messageColorFn`); pass an empty string to hide it.
	 */
	setDetailSuffix(suffix: string): void {
		const next = suffix.length > 0 ? this.messageColorFn(suffix) : "";
		if (next === this.coloredDetailSuffix) return;
		this.coloredDetailSuffix = next;
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
		this.subscribeAnimation();
		this.updateDisplay();
	}

	/**
	 * Freeze (or resume) the elapsed counter without resetting it — used while the
	 * turn is blocked waiting on the user. Pausing holds the displayed value;
	 * resuming discounts the paused span so the count continues uninterrupted
	 * instead of jumping by the wait time.
	 */
	setElapsedPaused(paused: boolean): void {
		if (paused === this.elapsedPaused) return;
		this.elapsedPaused = paused;
		if (paused) {
			this.pausedAtMs = Date.now();
		} else if (this.startedAtMs > 0) {
			this.startedAtMs += Date.now() - this.pausedAtMs;
			this.lastElapsedSec = -1;
		}
		this.updateDisplay();
	}

	/** Restart an enabled elapsed counter without replacing the loader. */
	resetElapsed(): void {
		if (!this.elapsedEnabled) return;
		const now = Date.now();
		this.startedAtMs = now;
		if (this.elapsedPaused) this.pausedAtMs = now;
		this.lastElapsedSec = -1;
		this.coloredElapsed = "";
		this.updateDisplay();
	}

	/**
	 * Backdate the elapsed origin (epoch ms). Hosts that rebuild the loader
	 * mid-task (retry backoff, compaction) pass the original start time so the
	 * counter continues the clock the user was already watching instead of
	 * restarting from zero. No-op while the counter is disabled.
	 */
	setElapsedOrigin(originMs: number): void {
		if (!this.elapsedEnabled || originMs === this.startedAtMs) return;
		this.startedAtMs = originMs;
		this.lastElapsedSec = -1;
		this.coloredElapsed = "";
		this.updateDisplay();
	}

	/** Elapsed milliseconds since the counter was enabled, discounting paused intervals. */
	getElapsedMs(): number {
		if (!this.elapsedEnabled || this.startedAtMs <= 0) {
			return 0;
		}
		if (this.elapsedPaused) {
			return Math.max(0, this.pausedAtMs - this.startedAtMs);
		}
		return Math.max(0, Date.now() - this.startedAtMs);
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
	private refreshElapsed(): boolean {
		if (!this.elapsedEnabled) {
			if (this.coloredElapsed !== "") {
				this.coloredElapsed = "";
				return true;
			}
			return false;
		}
		// While paused, hold the last rendered value (the agent is waiting on the
		// user, so the clock should not advance).
		if (this.elapsedPaused) return false;
		const sec = Math.floor((Date.now() - this.startedAtMs) / 1000);
		if (sec === this.lastElapsedSec) return false;
		this.lastElapsedSec = sec;
		// Hide the first second so the counter doesn't flash "0s" at turn start.
		this.coloredElapsed = sec > 0 ? this.messageColorFn(` ${Loader.formatElapsed(sec)}`) : "";
		return true;
	}

	/**
	 * Recolor the message label from the time-aware color fn for this frame. No-op
	 * (returns false) when no time-aware fn is set, so static callers pay nothing.
	 * Returns true only when the repainted label actually differs, so the ticker
	 * coalesces frames where the color is visually unchanged.
	 */
	private refreshMessageColor(now: number): boolean {
		if (!this.messageColorAtFn) return false;
		const next = this.messageColorAtFn(this.message, now);
		if (next === this.coloredMessage) return false;
		this.coloredMessage = next;
		return true;
	}

	setIndicator(indicator?: LoaderIndicatorOptions): void {
		this.renderIndicatorVerbatim = indicator !== undefined;
		this.frames = indicator?.frames !== undefined ? [...indicator.frames] : [...DEFAULT_FRAMES];
		this.intervalMs = indicator?.intervalMs && indicator.intervalMs > 0 ? indicator.intervalMs : DEFAULT_INTERVAL_MS;
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

	private subscribeAnimation(): void {
		this.unsubscribeAnimation();
		// Empty indicator: nothing to tick. A single frozen frame still needs the
		// ticker when elapsed is enabled (reduced-motion working loader) or a
		// time-aware label color is set (it repaints every frame).
		const needsTicker =
			this.frames.length > 1 ||
			(this.frames.length === 1 && (this.elapsedEnabled || this.messageColorAtFn !== null));
		if (!needsTicker || !this.ui) {
			return;
		}
		this.animationUnsub = this.ui.addAnimationCallback((now) => this.tick(now));
	}

	private unsubscribeAnimation(): void {
		if (this.animationUnsub) {
			this.animationUnsub();
			this.animationUnsub = null;
		}
	}

	/** Seed the spinner frame + pulse phase from the shared clock so the first
	 * paint already matches the global cadence (no frame-0 snap on creation). */
	private seedFrameFromClock(): void {
		if (this.frames.length === 0) {
			this.currentFrame = 0;
			this.paletteIndex = 0;
			return;
		}
		const now = performance.now();
		this.currentFrame = this.frameAt(now);
		this.paletteIndex = this.paletteAt(now);
	}

	private frameAt(now: number): number {
		return Math.floor(now / this.intervalMs) % this.frames.length;
	}

	/** Palette phase swept once per PULSE_CYCLE_MS, spread evenly across all
	 * phases, so the color pulse is independent of the spinner-frame cadence. */
	private paletteAt(now: number): number {
		const phases = this.coloredFrames.length;
		if (phases <= 1) return 0;
		return Math.floor(now / (PULSE_CYCLE_MS / phases)) % phases;
	}

	/**
	 * One animation step driven by the shared ticker. Derives the spinner frame
	 * and palette phase from the monotonic clock (so every Loader stays
	 * phase-locked) and repaints only when the visible string actually changes —
	 * the boolean return lets the ticker coalesce a single render per frame.
	 */
	private tick(now: number): boolean {
		if (this.frames.length === 0) {
			return false;
		}
		const frame = this.frameAt(now);
		const paletteIndex = this.paletteAt(now);
		const elapsedChanged = this.refreshElapsed();
		const messageChanged = this.refreshMessageColor(now);
		if (frame === this.currentFrame && paletteIndex === this.paletteIndex && !elapsedChanged && !messageChanged) {
			return false;
		}
		this.currentFrame = frame;
		this.paletteIndex = paletteIndex;
		const text = this.composeDisplayText();
		if (text === this.lastDisplayText) {
			return false;
		}
		this.lastDisplayText = text;
		this.setText(text);
		return true;
	}

	private composeDisplayText(): string {
		const rawFrame = this.frames[this.currentFrame] ?? "";
		const paletteRow = this.coloredFrames[this.paletteIndex] ?? this.coloredFrames[0] ?? [];
		const renderedFrame = paletteRow[this.currentFrame] ?? rawFrame;
		const indicator = rawFrame.length > 0 ? `${renderedFrame} ` : "";
		return `${indicator}${this.coloredMessage}${this.coloredDetailSuffix}${this.coloredElapsed}${this.coloredTrailingSuffix}`;
	}

	/** Imperative repaint for non-tick changes (message/indicator/elapsed
	 * toggles). Requests a render directly since it is not driven by the ticker. */
	private updateDisplay(): void {
		this.refreshElapsed();
		const text = this.composeDisplayText();
		this.lastDisplayText = text;
		this.setText(text);
		if (this.ui) {
			this.ui.requestRender();
		}
	}
}
