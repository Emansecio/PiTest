import { Spacer } from "@pit/tui";
import { describe, expect, test, vi } from "vitest";
import { TurnDoneMessageComponent } from "../src/modes/interactive/components/turn-done-message.js";
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

	test("agent_end appends TurnDoneMessageComponent when the loader retires", async () => {
		const added: unknown[] = [];
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			setTerminalProgress: vi.fn(),
			clearInterruptWatchdog: vi.fn(),
			disposeFusionLive: vi.fn(),
			shouldRetireWorkingLoaderOnAgentEnd,
			loadingAnimation: { getElapsedMs: () => 12_000 },
			stopWorkingLoader: vi.fn(),
			session: {
				orchestration: undefined,
				getContextUsage: () => ({ percent: 18, estimated: false }),
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

		expect(added.some((child) => child instanceof Spacer)).toBe(true);
		expect(added.some((child) => child instanceof TurnDoneMessageComponent)).toBe(true);
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
			stopWorkingLoader: vi.fn(),
			session: { orchestration: undefined, getContextUsage: () => null },
			disposeActiveStreamingComponent: vi.fn(),
			pendingTools: { values: () => [], clear: vi.fn(), delete: vi.fn(), get: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			appendTurnDoneLine: vi.fn(),
			chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
			checkShutdownRequested: vi.fn(),
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
			stopWorkingLoader: vi.fn(),
			session: { orchestration: "fusion", getContextUsage: () => null },
			disposeActiveStreamingComponent: vi.fn(),
			pendingTools: { values: () => [], clear: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			appendTurnDoneLine: vi.fn(),
			chatContainer: { addChild: vi.fn(), removeChild: vi.fn() },
			checkShutdownRequested: vi.fn(),
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
