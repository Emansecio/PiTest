import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import type { AskOptionsRequest } from "../src/core/user-input-bus.js";

// Partial-mock the theme module so we can assert stop() closes the theme watcher
// without a real fs.watch. Everything else (initTheme, theme, …) stays real so
// createAskPicker can still render.
vi.mock("../src/modes/interactive/theme/theme.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/modes/interactive/theme/theme.ts")>();
	return { ...actual, stopThemeWatcher: vi.fn() };
});

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme, stopThemeWatcher } from "../src/modes/interactive/theme/theme.js";
import { createInteractiveHarness } from "./interactive-harness.ts";

type HandleAskRequestThis = {
	pendingAskRequest: AskOptionsRequest | undefined;
	beginUserInputWait: (message: string) => () => void;
	awaitingUserInputMessage: string;
	showSelector: (factory: (done: () => void) => unknown) => void;
	ui: { requestRender: () => void };
};

function callHandleAskRequest(context: HandleAskRequestThis, req: AskOptionsRequest): void {
	(
		InteractiveMode.prototype as unknown as {
			handleAskRequest: (this: HandleAskRequestThis, r: AskOptionsRequest) => void;
		}
	).handleAskRequest.call(context, req);
}

describe("Leak 1: ask auto-answer timer is unref'd", () => {
	beforeAll(() => {
		initTheme(undefined, false);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	test("setTimeout for the auto-answer is unref'd so it cannot hold the loop", () => {
		const unref = vi.fn();
		const fakeHandle = { unref } as unknown as ReturnType<typeof setTimeout>;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockReturnValue(fakeHandle);

		const context: HandleAskRequestThis = {
			pendingAskRequest: undefined,
			beginUserInputWait: () => () => undefined,
			awaitingUserInputMessage: "waiting",
			showSelector: (factory) => {
				factory(() => undefined);
			},
			ui: { requestRender: vi.fn() },
		};

		const req: AskOptionsRequest = {
			requestId: "r",
			question: "Which one?",
			options: [{ label: "Alpha" }, { label: "Beta" }],
			source: {},
			timeout: 5000,
		};

		callHandleAskRequest(context, req);

		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000);
		expect(unref).toHaveBeenCalled();
	});
});

describe("Leak 2: interactive stop() closes the theme watcher", () => {
	afterEach(() => {
		vi.mocked(stopThemeWatcher).mockClear();
	});

	// Was a `stop.call(fakeThis)` against a hand-rolled 17-key object; now the real
	// instance, built headless on a VirtualTerminal, runs the real teardown.
	test("stop() calls stopThemeWatcher() on the normal teardown path", () => {
		const harness = createInteractiveHarness();

		harness.dispose();

		expect(stopThemeWatcher).toHaveBeenCalledTimes(1);
	});
});

describe("Leak 3: interactive stop() disposes the retry countdown", () => {
	// CountdownTimer owns a real `setInterval(…, 1000)` cleared only by dispose().
	// Quitting mid-backoff (or any fatal path) used to leave it live, holding the
	// Node event loop open.
	test("stop() tears down a live auto-retry backoff", async () => {
		const harness = createInteractiveHarness();

		await harness.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "boom",
		} as never);

		// Guard the guard: without a live countdown the assertion below is vacuous.
		expect(harness.internals().retryCountdown).toBeDefined();
		expect(harness.internals().retryLoader).toBeDefined();

		harness.dispose();

		expect(harness.internals().retryCountdown).toBeUndefined();
		expect(harness.internals().retryLoader).toBeUndefined();
	});

	test("stop() is a no-op for the retry surface when no retry is in flight", () => {
		const harness = createInteractiveHarness();

		expect(() => harness.dispose()).not.toThrow();
		expect(harness.internals().retryCountdown).toBeUndefined();
	});

	// The restore keyed off the SAVED HANDLER's truthiness, so an editor with no
	// prior onEscape (the headless case) kept the retry's abortRetry bound after the
	// retry ended — shadowing Esc-interrupts-the-turn. `retryEscapeBound` separates
	// "nothing was saved" from "undefined was saved".
	test("retry teardown restores an absent Esc handler instead of keeping abortRetry bound", async () => {
		const harness = createInteractiveHarness();
		const editor = harness.internals().defaultEditor;
		editor.onEscape = undefined;

		await harness.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "boom",
		} as never);
		expect(editor.onEscape).toBeTypeOf("function");

		await harness.emit({ type: "auto_retry_end", success: true, attempt: 1 } as never);

		expect(editor.onEscape).toBeUndefined();
		harness.dispose();
	});

	test("retry teardown restores a pre-existing Esc handler", async () => {
		const harness = createInteractiveHarness();
		const editor = harness.internals().defaultEditor;
		const original = () => undefined;
		editor.onEscape = original;

		await harness.emit({
			type: "auto_retry_start",
			attempt: 1,
			maxAttempts: 3,
			delayMs: 1000,
			errorMessage: "boom",
		} as never);
		expect(editor.onEscape).not.toBe(original);

		await harness.emit({ type: "auto_retry_end", success: true, attempt: 1 } as never);

		expect(editor.onEscape).toBe(original);
		harness.dispose();
	});
});
