import { type LoaderIndicatorOptions, SPINNER_FRAME_MS, SPINNER_FRAMES, type TUI } from "@pit/tui";
import { isReducedMotion } from "../../../utils/env-flags.ts";

export interface SpinnerTicker {
	/** Detach the animation callback. */
	stop(): void;
}

/**
 * Drive a single animation callback that calls `onFrame(glyph)` with the next
 * spinner frame while `shouldSpin()` is true, and `onFrame(null)` exactly once
 * when it flips to false. Idle (not spinning) ticks are cheap no-ops. Mirrors
 * ToolExecutionComponent's running spinner, but writes to a caller-owned sink
 * instead of the message-shell gutter.
 */
/** Spinner frame index at `clockMs` (P7 cadence); frozen to 0 under reduced motion. */
export function spinnerFrameIndexAt(clockMs: number): number {
	if (isReducedMotion()) return 0;
	return Math.floor(clockMs / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
}

/** Shared braille glyph at `clockMs`; frozen to frame 0 under reduced motion. */
export function spinnerGlyphAt(clockMs: number): string {
	return SPINNER_FRAMES[spinnerFrameIndexAt(clockMs)] ?? SPINNER_FRAMES[0];
}

/** Collapse animated loader indicators to a single frame when motion is reduced. */
export function reducedMotionLoaderIndicator(options?: LoaderIndicatorOptions): LoaderIndicatorOptions | undefined {
	if (!isReducedMotion()) return options;
	const frames = options?.frames;
	if (frames !== undefined) {
		if (frames.length <= 1) return options;
		return { ...options, frames: [frames[0]!] };
	}
	return { frames: [SPINNER_FRAMES[0]] };
}

export function createSpinnerTicker(
	ui: TUI,
	shouldSpin: () => boolean,
	onFrame: (glyph: string | null) => void,
): SpinnerTicker {
	let frame = -1;
	let cleared = true;
	const unsub = ui.addAnimationCallback((now: number) => {
		if (shouldSpin()) {
			cleared = false;
			const f = spinnerFrameIndexAt(now);
			if (f === frame) return false;
			frame = f;
			onFrame(SPINNER_FRAMES[f]);
			return true;
		}
		if (!cleared) {
			cleared = true;
			frame = -1;
			onFrame(null);
			return true;
		}
		return false;
	});
	return { stop: unsub };
}
