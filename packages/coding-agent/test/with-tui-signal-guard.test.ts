import { afterEach, describe, expect, test, vi } from "vitest";
import { withTuiSignalGuard } from "../src/cli/with-tui-signal-guard.js";

const GUARDED_EVENTS = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"] as const;

function baselineCounts(): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const ev of GUARDED_EVENTS) {
		counts[ev] = process.listenerCount(ev);
	}
	if (process.platform !== "win32") {
		counts.SIGHUP = process.listenerCount("SIGHUP");
	}
	return counts;
}

describe("withTuiSignalGuard", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("installs handlers during run() and removes ALL of them in finally", async () => {
		const before = baselineCounts();
		const ui = { stop: vi.fn() };

		let duringRun: Record<string, number> = {};
		const result = await withTuiSignalGuard(ui, async () => {
			duringRun = baselineCounts();
			return "ok";
		});

		expect(result).toBe("ok");
		// Each guarded event gained exactly one listener while run() was in flight.
		for (const ev of Object.keys(before)) {
			expect(duringRun[ev]).toBe(before[ev] + 1);
		}
		// ...and the process listener set returns to baseline afterwards.
		const after = baselineCounts();
		for (const ev of Object.keys(before)) {
			expect(after[ev]).toBe(before[ev]);
		}
	});

	test("removes handlers even when run() throws", async () => {
		const before = baselineCounts();
		const ui = { stop: vi.fn() };
		await expect(
			withTuiSignalGuard(ui, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		const after = baselineCounts();
		for (const ev of Object.keys(before)) {
			expect(after[ev]).toBe(before[ev]);
		}
	});

	test("a signal restores the terminal via ui.stop() and exits with 130 for SIGINT", async () => {
		const ui = { stop: vi.fn() };
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as unknown as typeof process.exit);
		let capturedSigint: ((...args: unknown[]) => void) | undefined;
		vi.spyOn(process, "prependListener").mockImplementation(((
			event: string | symbol,
			listener: (...a: unknown[]) => void,
		) => {
			if (String(event) === "SIGINT") capturedSigint = listener;
			return process;
		}) as typeof process.prependListener);
		vi.spyOn(process, "off").mockImplementation((() => process) as typeof process.off);

		await withTuiSignalGuard(ui, async () => {
			capturedSigint?.();
			return undefined;
		});

		expect(ui.stop).toHaveBeenCalledTimes(1);
		expect(exitSpy).toHaveBeenCalledWith(130);
	});
});
