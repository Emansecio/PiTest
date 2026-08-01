import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

/**
 * P3-A (2026-07 TUI review): Ctrl+D with an empty editor used to shut down
 * unconditionally — one fat-fingered keystroke could kill a running turn.
 * Mid-turn it now requires the same double-press window Ctrl+C uses (the
 * timestamp is shared, so Ctrl+C and Ctrl+D arm ONE window); idle keeps the
 * direct single-press exit.
 */

const handleCtrlD = Reflect.get(InteractiveMode.prototype, "handleCtrlD") as (this: Record<string, unknown>) => void;

function makeFakeThis(opts: { isBusy: boolean; lastSigintTime?: number }) {
	return {
		session: { isBusy: opts.isBusy },
		lastSigintTime: opts.lastSigintTime ?? 0,
		shutdown: vi.fn(async () => undefined),
		showCtrlCHint: vi.fn(),
		clearCtrlCHint: vi.fn(),
	};
}

describe("InteractiveMode.handleCtrlD", () => {
	test("idle: a single Ctrl+D exits directly (no hint, no window)", () => {
		const fakeThis = makeFakeThis({ isBusy: false });
		handleCtrlD.call(fakeThis);
		expect(fakeThis.shutdown).toHaveBeenCalledTimes(1);
		expect(fakeThis.showCtrlCHint).not.toHaveBeenCalled();
	});

	test("busy: the FIRST Ctrl+D does not shut down — it arms the window and shows a ctrl+d hint", () => {
		const fakeThis = makeFakeThis({ isBusy: true });
		handleCtrlD.call(fakeThis);
		expect(fakeThis.shutdown).not.toHaveBeenCalled();
		expect(fakeThis.showCtrlCHint).toHaveBeenCalledWith("ctrl+d");
		expect(fakeThis.lastSigintTime).toBeGreaterThan(0);
	});

	test("busy: a second Ctrl+D within the window shuts down and clears the hint", () => {
		const fakeThis = makeFakeThis({ isBusy: true });
		handleCtrlD.call(fakeThis);
		handleCtrlD.call(fakeThis);
		expect(fakeThis.shutdown).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearCtrlCHint).toHaveBeenCalledTimes(1);
	});

	test("busy: an expired window re-arms instead of exiting", () => {
		// Well past CTRL_C_EXIT_WINDOW_MS (1.5s).
		const fakeThis = makeFakeThis({ isBusy: true, lastSigintTime: Date.now() - 10_000 });
		handleCtrlD.call(fakeThis);
		expect(fakeThis.shutdown).not.toHaveBeenCalled();
		expect(fakeThis.showCtrlCHint).toHaveBeenCalledTimes(1);
	});

	test("busy: Ctrl+C then Ctrl+D share one exit window (shared lastSigintTime)", () => {
		// handleCtrlC just armed the window: lastSigintTime is fresh.
		const fakeThis = makeFakeThis({ isBusy: true, lastSigintTime: Date.now() });
		handleCtrlD.call(fakeThis);
		expect(fakeThis.shutdown).toHaveBeenCalledTimes(1);
	});
});
