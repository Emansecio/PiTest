import { setKeybindings } from "@pit/tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type AskOptionsRequest, createUserInputBus } from "../src/core/user-input-bus.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

/**
 * P3-C (2026-07 TUI review): the "Interrupt what?" picker
 * (promptInterruptChoice) was not tied to the turn's lifetime — if the tools
 * finished with the picker still open, it kept asking about a DEAD turn, and
 * any answer then "interrupted" nothing (or worse, the cancel fallback ran the
 * whole stop-the-task path post-mortem). agent_end now closes the pending
 * interrupt ask via cancelInterruptAskOnTurnEnd(), and promptInterruptChoice
 * swallows that supersession instead of falling back to stop-all.
 */

const proto = InteractiveMode.prototype as unknown as Record<string, any>;
const promptInterruptChoice = proto.promptInterruptChoice as (
	this: unknown,
	tools: Array<{ id: string; name: string }>,
) => Promise<void>;
const handleAskRequest = proto.handleAskRequest as (this: unknown, req: AskOptionsRequest) => void;
/** Collaborators handleAskRequest delegates to (queue + picker presentation). */
const askQueueMethods = {
	askQueue: [] as AskOptionsRequest[],
	presentAskRequest: proto.presentAskRequest,
	refreshAskQueueBadge: proto.refreshAskQueueBadge,
	advanceAskQueue: proto.advanceAskQueue,
};
const cancelInterruptAskOnTurnEnd = proto.cancelInterruptAskOnTurnEnd as (this: unknown) => void;
const handleEvent = proto.handleEvent as (this: unknown, event: Record<string, unknown>) => Promise<void>;

beforeAll(() => {
	initTheme("dark");
	// createAskPicker renders real components; keybinding hints need a manager.
	setKeybindings(new KeybindingsManager());
});

describe("cancelInterruptAskOnTurnEnd", () => {
	test("closes a pending interrupt ask and flags the supersession", () => {
		const fakeThis: Record<string, any> = {
			pendingAskRequest: { source: { toolName: "interrupt" } },
			pendingAskCancel: vi.fn(),
			interruptAskSuperseded: false,
		};
		cancelInterruptAskOnTurnEnd.call(fakeThis);
		expect(fakeThis.pendingAskCancel).toHaveBeenCalledTimes(1);
		expect(fakeThis.interruptAskSuperseded).toBe(true);
	});

	test("leaves a non-interrupt ask (e.g. the ask tool's own picker) alone", () => {
		const fakeThis: Record<string, any> = {
			pendingAskRequest: { source: { toolName: "ask" } },
			pendingAskCancel: vi.fn(),
			interruptAskSuperseded: false,
		};
		cancelInterruptAskOnTurnEnd.call(fakeThis);
		expect(fakeThis.pendingAskCancel).not.toHaveBeenCalled();
		expect(fakeThis.interruptAskSuperseded).toBe(false);
	});

	test("no-op when nothing is pending", () => {
		const fakeThis: Record<string, any> = {
			pendingAskRequest: undefined,
			pendingAskCancel: undefined,
			interruptAskSuperseded: false,
		};
		expect(() => cancelInterruptAskOnTurnEnd.call(fakeThis)).not.toThrow();
		expect(fakeThis.interruptAskSuperseded).toBe(false);
	});
});

describe("agent_end closes a still-open interrupt picker", () => {
	function makeAgentEndFakeThis() {
		return {
			isInitialized: true,
			init: vi.fn(),
			setTerminalProgress: vi.fn(),
			clearInterruptWatchdog: vi.fn(),
			cancelInterruptAskOnTurnEnd: vi.fn(),
			disposeFusionLive: vi.fn(),
			disposeAgentsLive: vi.fn(),
			clearThinkingPreview: vi.fn(),
			shouldRetireWorkingLoaderOnAgentEnd: proto.shouldRetireWorkingLoaderOnAgentEnd,
			loadingAnimation: {},
			getWorkingLoaderElapsedMs: proto.getWorkingLoaderElapsedMs,
			stopWorkingLoader: vi.fn(),
			session: { orchestration: undefined, getContextUsage: () => null },
			disposeActiveStreamingComponent: vi.fn(),
			pendingTools: { values: () => [], clear: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			appendTurnDoneLine: vi.fn(),
			chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
			checkShutdownRequested: vi.fn(),
			maybeShowPowerTip: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
	}

	test("agent_end (final) cancels the pending interrupt ask", async () => {
		const fakeThis = makeAgentEndFakeThis();
		await handleEvent.call(fakeThis, { type: "agent_end", willRetry: false, messages: [] });
		expect(fakeThis.cancelInterruptAskOnTurnEnd).toHaveBeenCalledTimes(1);
	});

	test("agent_end with willRetry keeps the picker (the run is still alive)", async () => {
		const fakeThis = makeAgentEndFakeThis();
		await handleEvent.call(fakeThis, { type: "agent_end", willRetry: true, messages: [] });
		expect(fakeThis.cancelInterruptAskOnTurnEnd).not.toHaveBeenCalled();
	});
});

describe("promptInterruptChoice under turn-end supersession (real bus + real ask wiring)", () => {
	function makePickerFakeThis() {
		const closed = vi.fn();
		const fakeThis: Record<string, any> = {
			...askQueueMethods,
			askQueue: [],
			userInputBus: createUserInputBus(),
			pendingAskRequest: undefined,
			pendingAskCancel: undefined,
			interruptAskSuperseded: false,
			beginUserInputWait: vi.fn(() => vi.fn()),
			awaitingUserInputMessage: "Waiting for your answer…",
			// Run the real factory so the `close` teardown is wired exactly as in
			// production (createAskPicker renders for real; `closed` is its done).
			showSelector: (create: (done: () => void) => unknown) => {
				create(closed);
			},
			dismissStartupScreen: vi.fn(),
			ui: { requestRender: vi.fn() },
			// Stop-all path spies — the supersession test asserts these stay cold.
			restoreQueuedMessagesToEditor: vi.fn(),
			session: { interrupt: vi.fn(), cancelTool: vi.fn() },
			disposeFusionLive: vi.fn(),
			disposeAgentsLive: vi.fn(),
			deferredTurnDone: {},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			petCompanion: undefined,
			armInterruptWatchdog: vi.fn(),
		};
		fakeThis.userInputBus.onRequest((req: AskOptionsRequest) => handleAskRequest.call(fakeThis, req));
		return { fakeThis, closed };
	}

	const TOOLS = [
		{ id: "t1", name: "bash" },
		{ id: "t2", name: "read" },
	];

	test("turn-end cancellation closes the picker WITHOUT running the stop-all fallback", async () => {
		const { fakeThis, closed } = makePickerFakeThis();

		const pending = promptInterruptChoice.call(fakeThis, TOOLS);
		// The ask is registered synchronously and tagged as the interrupt picker.
		expect(fakeThis.pendingAskRequest?.source.toolName).toBe("interrupt");

		cancelInterruptAskOnTurnEnd.call(fakeThis);
		await pending;

		expect(closed).toHaveBeenCalledTimes(1); // picker torn down
		expect(fakeThis.pendingAskRequest).toBeUndefined();
		expect(fakeThis.interruptAskSuperseded).toBe(false); // flag consumed
		// Nothing of the dead turn was "interrupted".
		expect(fakeThis.session.interrupt).not.toHaveBeenCalled();
		expect(fakeThis.restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
		expect(fakeThis.stopWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
		expect(fakeThis.armInterruptWatchdog).not.toHaveBeenCalled();
	});

	test("regression: a user-cancelled picker with the turn still alive keeps the stop-all fallback", async () => {
		const fakeThis: Record<string, any> = {
			interruptAskSuperseded: false,
			userInputBus: {
				askOptions: vi.fn(async () => ({ requestId: "r", picked: [], cancelled: true })),
			},
			restoreQueuedMessagesToEditor: vi.fn(),
			session: { interrupt: vi.fn(), cancelTool: vi.fn() },
			disposeFusionLive: vi.fn(),
			disposeAgentsLive: vi.fn(),
			deferredTurnDone: {},
			stopWorkingLoader: vi.fn(),
			showStatus: vi.fn(),
			petCompanion: undefined,
			armInterruptWatchdog: vi.fn(),
		};

		await promptInterruptChoice.call(fakeThis, TOOLS);

		expect(fakeThis.session.interrupt).toHaveBeenCalledTimes(1);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Interrupted");
		expect(fakeThis.armInterruptWatchdog).toHaveBeenCalledTimes(1);
	});
});
