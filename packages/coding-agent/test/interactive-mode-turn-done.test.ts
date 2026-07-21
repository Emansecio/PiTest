import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

describe("InteractiveMode turn done rendering", () => {
	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: Record<string, unknown>,
		event: { type: string; messages?: unknown[]; willRetry?: boolean },
	) => Promise<void>;

	const shouldRetireWorkingLoaderOnAgentEnd = Reflect.get(
		InteractiveMode.prototype,
		"shouldRetireWorkingLoaderOnAgentEnd",
	) as (willRetry: boolean) => boolean;

	test("agent_end omits the normal turn-done marker when the loader retires", async () => {
		const added: unknown[] = [];
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			setTerminalProgress: vi.fn(),
			clearInterruptWatchdog: vi.fn(),
			disposeFusionLive: vi.fn(),
			shouldRetireWorkingLoaderOnAgentEnd,
			loadingAnimation: { getElapsedMs: () => 12_000 },
			getWorkingLoaderElapsedMs: Reflect.get(InteractiveMode.prototype, "getWorkingLoaderElapsedMs"),
			stopWorkingLoader: vi.fn(),
			deferredTurnDone: null,
			session: {
				orchestration: undefined,
				getContextUsage: () => ({ percent: 18, estimated: false }),
				isStreaming: true,
				isBusy: true,
				hasPendingPostTurnWork: false,
			},
			disposeActiveStreamingComponent: vi.fn(),
			pendingTools: { values: () => [], clear: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			appendTurnDoneLine: Reflect.get(InteractiveMode.prototype, "appendTurnDoneLine"),
			chatContainer: {
				addChild: vi.fn((child: unknown) => added.push(child)),
				removeChild: vi.fn(),
			},
			checkShutdownRequested: vi.fn(),
			maybeShowPowerTip: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await handleEvent.call(fakeThis, {
			type: "agent_end",
			willRetry: false,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					stopReason: "stop",
				},
			],
		});

		expect(added).toHaveLength(0);
	});

	test("agent_end defers turn-done when post-turn gates will run", async () => {
		const resetElapsed = vi.fn();
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			setTerminalProgress: vi.fn(),
			clearInterruptWatchdog: vi.fn(),
			disposeFusionLive: vi.fn(),
			shouldRetireWorkingLoaderOnAgentEnd,
			loadingAnimation: { getElapsedMs: () => 12_000, resetElapsed },
			getWorkingLoaderElapsedMs: Reflect.get(InteractiveMode.prototype, "getWorkingLoaderElapsedMs"),
			setWorkingPhase: vi.fn(),
			stopWorkingLoader: vi.fn(),
			deferredTurnDone: null as unknown,
			session: {
				orchestration: undefined,
				getContextUsage: () => ({ percent: 18, estimated: false }),
				isStreaming: true,
				isBusy: true,
				hasPendingPostTurnWork: true,
			},
			disposeActiveStreamingComponent: vi.fn(),
			pendingTools: { values: () => [], clear: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			appendTurnDoneLine: vi.fn(),
			chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
			checkShutdownRequested: vi.fn(),
			maybeShowPowerTip: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await handleEvent.call(fakeThis, {
			type: "agent_end",
			willRetry: false,
			messages: [
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
					stopReason: "stop",
				},
			],
		});

		expect(fakeThis.stopWorkingLoader).not.toHaveBeenCalled();
		expect(fakeThis.appendTurnDoneLine).not.toHaveBeenCalled();
		expect(fakeThis.deferredTurnDone).not.toBeNull();
		expect(resetElapsed).toHaveBeenCalledOnce();
		expect(fakeThis.setWorkingPhase).toHaveBeenCalledWith("Final answer ready · finishing checks…");
	});

	test("self_review replaces stale gate text with an explicit post-turn phase", async () => {
		const resetElapsed = vi.fn();
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			setTerminalProgress: vi.fn(),
			workingVisible: true,
			loadingAnimation: { resetElapsed },
			setWorkingPhase: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await handleEvent.call(fakeThis, { type: "self_review", phase: "running" });

		expect(fakeThis.setTerminalProgress).toHaveBeenCalledWith(true);
		expect(resetElapsed).toHaveBeenCalledOnce();
		expect(fakeThis.setWorkingPhase).toHaveBeenCalledWith("Reviewing final changes…");
	});

	test("prompt_end retires the loader and flushes deferred turn-done", async () => {
		const added: unknown[] = [];
		const deferred = { kind: "turn-done" };
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			settleWorkingLoaderAfterPrompt: Reflect.get(InteractiveMode.prototype, "settleWorkingLoaderAfterPrompt"),
			clearInterruptWatchdog: vi.fn(),
			deferredTurnDone: deferred,
			loadingAnimation: { stop: vi.fn() },
			stopWorkingLoader: vi.fn(function (this: { loadingAnimation: unknown }) {
				this.loadingAnimation = undefined;
			}),
			session: { orchestration: undefined },
			appendTurnDoneLine: vi.fn((snapshot: unknown) => added.push(snapshot)),
			ui: { requestRender: vi.fn() },
		};

		await handleEvent.call(fakeThis, { type: "prompt_end" });

		expect(fakeThis.stopWorkingLoader).toHaveBeenCalledOnce();
		expect(fakeThis.appendTurnDoneLine).toHaveBeenCalledWith(deferred);
		expect(fakeThis.deferredTurnDone).toBeNull();
	});

	test("agent_end still cleans up when the loader does not expose elapsed time", async () => {
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			setTerminalProgress: vi.fn(),
			clearInterruptWatchdog: vi.fn(),
			disposeFusionLive: vi.fn(),
			shouldRetireWorkingLoaderOnAgentEnd,
			loadingAnimation: {},
			getWorkingLoaderElapsedMs: Reflect.get(InteractiveMode.prototype, "getWorkingLoaderElapsedMs"),
			stopWorkingLoader: vi.fn(),
			session: {
				orchestration: undefined,
				getContextUsage: () => null,
			},
			disposeActiveStreamingComponent: vi.fn(),
			pendingTools: { values: () => [], clear: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			appendTurnDoneLine: vi.fn(),
			chatContainer: {
				addChild: vi.fn(),
				removeChild: vi.fn(),
			},
			checkShutdownRequested: vi.fn(),
			maybeShowPowerTip: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await handleEvent.call(fakeThis, {
			type: "agent_end",
			willRetry: false,
			messages: [],
		});

		expect(fakeThis.stopWorkingLoader).toHaveBeenCalledOnce();
		expect(fakeThis.appendTurnDoneLine).toHaveBeenCalledOnce();
	});

	test("agent_end skips turn done when willRetry is true", async () => {
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			setTerminalProgress: vi.fn(),
			clearInterruptWatchdog: vi.fn(),
			disposeFusionLive: vi.fn(),
			shouldRetireWorkingLoaderOnAgentEnd,
			loadingAnimation: { getElapsedMs: () => 1000 },
			getWorkingLoaderElapsedMs: Reflect.get(InteractiveMode.prototype, "getWorkingLoaderElapsedMs"),
			stopWorkingLoader: vi.fn(),
			session: { orchestration: undefined, getContextUsage: () => null },
			disposeActiveStreamingComponent: vi.fn(),
			pendingTools: { values: () => [], clear: vi.fn(), delete: vi.fn(), get: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			appendTurnDoneLine: vi.fn(),
			chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
			checkShutdownRequested: vi.fn(),
			maybeShowPowerTip: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await handleEvent.call(fakeThis, {
			type: "agent_end",
			willRetry: true,
			messages: [],
		});

		expect(fakeThis.appendTurnDoneLine).not.toHaveBeenCalled();
	});

	test("agent_end skips turn done for fusion orchestration", async () => {
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			setTerminalProgress: vi.fn(),
			clearInterruptWatchdog: vi.fn(),
			disposeFusionLive: vi.fn(),
			shouldRetireWorkingLoaderOnAgentEnd,
			loadingAnimation: { getElapsedMs: () => 1000 },
			getWorkingLoaderElapsedMs: Reflect.get(InteractiveMode.prototype, "getWorkingLoaderElapsedMs"),
			stopWorkingLoader: vi.fn(),
			session: { orchestration: "fusion", getContextUsage: () => null },
			disposeActiveStreamingComponent: vi.fn(),
			pendingTools: { values: () => [], clear: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			appendTurnDoneLine: vi.fn(),
			chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
			checkShutdownRequested: vi.fn(),
			maybeShowPowerTip: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		await handleEvent.call(fakeThis, {
			type: "agent_end",
			willRetry: false,
			messages: [],
		});

		expect(fakeThis.appendTurnDoneLine).not.toHaveBeenCalled();
	});
});
