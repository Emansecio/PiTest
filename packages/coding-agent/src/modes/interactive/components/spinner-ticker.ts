import { type LoaderIndicatorOptions, SPINNER_FRAME_MS, type TUI } from "@pit/tui";
import { isReducedMotion } from "../../../utils/env-flags.ts";
import { resolveSpinnerFrames } from "./glyph-resolver.ts";

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
	const frames = resolveSpinnerFrames();
	return Math.floor(clockMs / SPINNER_FRAME_MS) % frames.length;
}

/** Shared spinner glyph at `clockMs` (braille or ASCII under PIT_ASCII); frozen under reduced motion. */
export function spinnerGlyphAt(clockMs: number): string {
	const frames = resolveSpinnerFrames();
	return frames[spinnerFrameIndexAt(clockMs)] ?? frames[0]!;
}

/** Collapse animated loader indicators to a single frame when motion is reduced. */
export function reducedMotionLoaderIndicator(options?: LoaderIndicatorOptions): LoaderIndicatorOptions | undefined {
	const resolved = options?.frames ?? [...resolveSpinnerFrames()];
	if (!isReducedMotion()) {
		// Ensure Loader uses the ASCII set when PIT_ASCII is on even without reduced motion.
		if (!options?.frames) return { ...options, frames: [...resolveSpinnerFrames()] };
		return options;
	}
	const frames = resolved;
	if (frames.length <= 1) return { ...options, frames };
	return { ...options, frames: [frames[0]!] };
}

export function createSpinnerTicker(
	ui: TUI,
	shouldSpin: () => boolean,
	onFrame: (glyph: string | null) => void,
	/** When true, hold the current glyph and skip dirty frames (e.g. working
	 * loader already owns the animated zone). Elapsed clocks still tick once/s. */
	isFrozen?: () => boolean,
): SpinnerTicker {
	let frame = -1;
	let cleared = true;
	// Under reduced motion the glyph is frozen, but activity/nav/bash elapsed
	// suffixes (`· Ns`) are computed in render(). Emit dirty once per second so
	// those clocks keep advancing (M0).
	let lastElapsedSec = -1;
	const unsub = ui.addAnimationCallback((now: number) => {
		const frames = resolveSpinnerFrames();
		if (shouldSpin()) {
			cleared = false;
			// Working-loader owns the animated zone: hold the current activity
			// glyph (or frame 0) and only dirty once/s for elapsed suffixes.
			if (isFrozen?.()) {
				const sec = Math.floor(now / 1000);
				const glyph = frames[frame >= 0 ? frame : 0] ?? frames[0]!;
				if (frame < 0) {
					frame = 0;
					lastElapsedSec = sec;
					onFrame(glyph);
					return true;
				}
				if (sec !== lastElapsedSec) {
					lastElapsedSec = sec;
					onFrame(glyph);
					return true;
				}
				return false;
			}
			if (isReducedMotion()) {
				const sec = Math.floor(now / 1000);
				const glyph = frames[0]!;
				if (frame !== 0) {
					frame = 0;
					lastElapsedSec = sec;
					onFrame(glyph);
					return true;
				}
				if (sec !== lastElapsedSec) {
					lastElapsedSec = sec;
					onFrame(glyph);
					return true;
				}
				return false;
			}
			const f = spinnerFrameIndexAt(now);
			if (f === frame) return false;
			frame = f;
			onFrame(frames[f]!);
			return true;
		}
		if (!cleared) {
			cleared = true;
			frame = -1;
			lastElapsedSec = -1;
			onFrame(null);
			return true;
		}
		return false;
	});
	return { stop: unsub };
}
