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

type StopThis = {
	unregisterSignalHandlers: () => void;
	setTerminalProgress: (on: boolean) => void;
	clearInterruptWatchdog: () => void;
	_themePreviewInvalidateTimer: ReturnType<typeof setTimeout> | undefined;
	ephemeralStatus: { dispose: () => void };
	stopStartupAnimation: () => void;
	petCompanionUnsub: (() => void) | undefined;
	composerChrome: { setRightGutter: (component: undefined) => void };
	petCompanion: unknown;
	loadingAnimation: { stop: () => void } | undefined;
	clearExtensionTerminalInputListeners: () => void;
	footer: { dispose: () => void };
	footerDataProvider: { dispose: () => void };
	unsubscribe: (() => void) | undefined;
	diagnosticsUnsubscribe: (() => void) | undefined;
	isInitialized: boolean;
};

function callStop(context: StopThis): void {
	(InteractiveMode.prototype as unknown as { stop: (this: StopThis) => void }).stop.call(context);
}

describe("Leak 2: interactive stop() closes the theme watcher", () => {
	afterEach(() => {
		vi.mocked(stopThemeWatcher).mockClear();
	});

	test("stop() calls stopThemeWatcher() on the normal teardown path", () => {
		const context: StopThis = {
			unregisterSignalHandlers: vi.fn(),
			setTerminalProgress: vi.fn(),
			clearInterruptWatchdog: vi.fn(),
			_themePreviewInvalidateTimer: undefined,
			ephemeralStatus: { dispose: vi.fn() },
			stopStartupAnimation: vi.fn(),
			petCompanionUnsub: undefined,
			composerChrome: { setRightGutter: vi.fn() },
			petCompanion: undefined,
			loadingAnimation: undefined,
			clearExtensionTerminalInputListeners: vi.fn(),
			footer: { dispose: vi.fn() },
			footerDataProvider: { dispose: vi.fn() },
			unsubscribe: undefined,
			diagnosticsUnsubscribe: undefined,
			isInitialized: false,
		};

		callStop(context);

		expect(stopThemeWatcher).toHaveBeenCalledTimes(1);
	});
});
