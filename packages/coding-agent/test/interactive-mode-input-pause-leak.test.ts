import { describe, expect, test, vi } from "vitest";
import type { AskOptionsRequest } from "../src/core/user-input-bus.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

// H25: the working clock freezes at "Waiting for you…" while `userInputPauseDepth > 0`.
// Every extension dialog releases its hold via `.finally(releaseWait)`, but the two
// manual holders — `showSelector` and `handleAskRequest` — released only through their
// success/teardown callbacks. If component construction threw, the pause leaked and the
// clock stayed frozen forever (and, for ask, the bus hung + pendingAskRequest poisoned).
// The fix makes both release exception-safe.

const showSelector = Reflect.get(InteractiveMode.prototype, "showSelector") as (
	this: Record<string, unknown>,
	create: (done: () => void) => unknown,
) => void;

const handleAskRequest = Reflect.get(InteractiveMode.prototype, "handleAskRequest") as (
	this: Record<string, unknown>,
	req: AskOptionsRequest,
) => void;

/** Queue collaborators `handleAskRequest` delegates to; real prototype methods. */
const askQueueMethods = (): Record<string, unknown> => ({
	askQueue: [] as AskOptionsRequest[],
	presentAskRequest: Reflect.get(InteractiveMode.prototype, "presentAskRequest"),
	refreshAskQueueBadge: Reflect.get(InteractiveMode.prototype, "refreshAskQueueBadge"),
	advanceAskQueue: Reflect.get(InteractiveMode.prototype, "advanceAskQueue"),
});

describe("H25: showSelector releases the input-pause even when the factory throws", () => {
	test("a throwing factory still releases the pause (clock never freezes)", () => {
		const release = vi.fn();
		const fakeThis: Record<string, unknown> = {
			sendNowChooser: undefined,
			beginUserInputWait: vi.fn(() => release),
			userWaitMessage: "Waiting for you…",
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		};

		expect(() =>
			showSelector.call(fakeThis, () => {
				throw new Error("component blew up");
			}),
		).toThrow("component blew up");

		// Pause released on the throw path — no orphaned depth.
		expect(release).toHaveBeenCalledTimes(1);
	});

	test("the normal path releases only via `done`, not eagerly", () => {
		const release = vi.fn();
		let captured: (() => void) | undefined;
		const fakeThis: Record<string, unknown> = {
			sendNowChooser: undefined,
			beginUserInputWait: vi.fn(() => release),
			userWaitMessage: "Waiting for you…",
			editorContainer: { clear: vi.fn(), addChild: vi.fn() },
			editor: {},
			ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		};

		showSelector.call(fakeThis, (done: () => void) => {
			captured = done;
			return { component: {}, focus: {} };
		});

		// Wired successfully → not released yet.
		expect(release).not.toHaveBeenCalled();
		captured?.();
		expect(release).toHaveBeenCalledTimes(1);
	});
});

describe("H25: handleAskRequest releases + answers the bus when the picker wiring throws", () => {
	test("a throw in showSelector releases the pause, answers the bus, and un-poisons pendingAskRequest", () => {
		const release = vi.fn();
		const resolve = vi.fn();
		const fakeThis: Record<string, unknown> = {
			...askQueueMethods(),
			pendingAskRequest: undefined,
			beginUserInputWait: vi.fn(() => release),
			awaitingUserInputMessage: "Waiting for your answer…",
			showSelector: vi.fn(() => {
				throw new Error("picker blew up");
			}),
			userInputBus: { resolve },
			showError: vi.fn(),
			dismissStartupScreen: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		const req: AskOptionsRequest = {
			requestId: "r1",
			question: "Which one?",
			options: [{ label: "Alpha" }, { label: "Beta" }],
			source: {},
		};

		handleAskRequest.call(fakeThis, req);

		expect(release).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect((resolve.mock.calls[0] as unknown[])[0]).toBe("r1");
		expect(fakeThis.pendingAskRequest).toBeUndefined();
		expect(fakeThis.showError).toHaveBeenCalled();
	});

	test("overlay mode: an async rejection from showExtensionCustom also releases + answers the bus", async () => {
		const release = vi.fn();
		const resolve = vi.fn();
		const fakeThis: Record<string, unknown> = {
			...askQueueMethods(),
			pendingAskRequest: undefined,
			beginUserInputWait: vi.fn(() => release),
			awaitingUserInputMessage: "Waiting for your answer…",
			// The overlay path is async; a factory failure surfaces as a rejected promise.
			showExtensionCustom: vi.fn(() => Promise.reject(new Error("overlay blew up"))),
			userInputBus: { resolve },
			showError: vi.fn(),
			dismissStartupScreen: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		const req: AskOptionsRequest = {
			requestId: "r2",
			question: "Which one?",
			options: [{ label: "Alpha" }],
			source: {},
			displayMode: "overlay",
		};

		handleAskRequest.call(fakeThis, req);
		// Let the rejected promise's .catch run.
		await Promise.resolve();
		await Promise.resolve();

		expect(release).toHaveBeenCalledTimes(1);
		expect(resolve).toHaveBeenCalledTimes(1);
		expect(fakeThis.pendingAskRequest).toBeUndefined();
		expect(fakeThis.showError).toHaveBeenCalled();
	});
});
