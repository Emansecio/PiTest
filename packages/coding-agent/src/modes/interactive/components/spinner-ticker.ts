import { SPINNER_FRAME_MS, SPINNER_FRAMES, type TUI } from "@pit/tui";

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
			const f = Math.floor(now / SPINNER_FRAME_MS) % SPINNER_FRAMES.length;
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
