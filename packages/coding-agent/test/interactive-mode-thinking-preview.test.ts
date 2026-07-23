import type { AssistantMessage, AssistantMessageEvent, Usage } from "@pit/ai";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	delete process.env.PIT_NO_THINKING_PREVIEW;
});

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(content: AssistantMessage["content"] = []): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("InteractiveMode thinking preview", () => {
	const handleThinkingPreviewEvent = Reflect.get(InteractiveMode.prototype, "handleThinkingPreviewEvent") as (
		this: Record<string, unknown>,
		event: AssistantMessageEvent,
	) => void;
	const clearThinkingPreview = Reflect.get(InteractiveMode.prototype, "clearThinkingPreview") as (
		this: Record<string, unknown>,
	) => void;
	const flushThinkingPreview = Reflect.get(InteractiveMode.prototype, "flushThinkingPreview") as (
		this: Record<string, unknown>,
	) => void;
	const applyThinkingPreview = Reflect.get(InteractiveMode.prototype, "applyThinkingPreview") as (
		this: Record<string, unknown>,
		tail: string,
	) => void;
	const thinkingPreviewMaxWidth = Reflect.get(InteractiveMode.prototype, "thinkingPreviewMaxWidth") as (
		this: Record<string, unknown>,
	) => number;

	function makeFakeThis(columns = 80) {
		const setDetailSuffix = vi.fn();
		return {
			loadingAnimation: { setDetailSuffix },
			ui: { terminal: { columns } },
			thinkingPreviewRaw: "",
			thinkingPreviewLastAppliedAt: 0,
			lastAppliedThinkingPreview: "",
			applyThinkingPreview,
			flushThinkingPreview,
			clearThinkingPreview,
			thinkingPreviewMaxWidth,
			setDetailSuffix,
		};
	}

	function thinkingDelta(delta: string, contentIndex = 0): AssistantMessageEvent {
		return { type: "thinking_delta", delta, contentIndex, partial: assistantMessage() };
	}

	test("accumulates thinking_delta text and pushes a sanitized tail to the loader", () => {
		const fakeThis = makeFakeThis();
		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("let me check the edit-precondition case"));
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);
		const shown = stripAnsi(String(fakeThis.setDetailSuffix.mock.calls[0]![0]));
		expect(shown).toContain("let me check the edit-precondition case");
		expect(fakeThis.thinkingPreviewRaw).toBe("let me check the edit-precondition case");
	});

	test("ignores whitespace-only deltas: no accumulation, no repaint", () => {
		const fakeThis = makeFakeThis();
		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("   \n\t  "));
		expect(fakeThis.setDetailSuffix).not.toHaveBeenCalled();
		expect(fakeThis.thinkingPreviewRaw).toBe("");
	});

	test("throttles repeated deltas within the ~300ms window", () => {
		const fakeThis = makeFakeThis();
		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("first chunk "));
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);

		// Immediately after: still within the throttle window.
		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("second chunk"));
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);
		// The raw accumulator still grows even while the repaint is throttled.
		expect(fakeThis.thinkingPreviewRaw).toBe("first chunk second chunk");

		// Simulate the throttle window having elapsed.
		fakeThis.thinkingPreviewLastAppliedAt = 0;
		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta(" third chunk"));
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(2);
		const shown = stripAnsi(String(fakeThis.setDetailSuffix.mock.calls[1]![0]));
		expect(shown).toContain("third chunk");
	});

	test("clears the tail on text_start", () => {
		const fakeThis = makeFakeThis();
		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("reasoning before text"));
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);

		handleThinkingPreviewEvent.call(fakeThis, {
			type: "text_start",
			contentIndex: 1,
			partial: assistantMessage(),
		});
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(2);
		expect(stripAnsi(String(fakeThis.setDetailSuffix.mock.calls[1]![0]))).toBe("");
		expect(fakeThis.thinkingPreviewRaw).toBe("");
	});

	test("clears the tail on toolcall_start", () => {
		const fakeThis = makeFakeThis();
		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("reasoning before a tool call"));
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);

		handleThinkingPreviewEvent.call(fakeThis, {
			type: "toolcall_start",
			contentIndex: 1,
			partial: assistantMessage(),
		});
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(2);
		expect(stripAnsi(String(fakeThis.setDetailSuffix.mock.calls[1]![0]))).toBe("");
	});

	test("other stream events (text_delta, thinking_start, toolcall_delta) are a no-op", () => {
		const fakeThis = makeFakeThis();
		const events: AssistantMessageEvent[] = [
			{ type: "thinking_start", contentIndex: 0, partial: assistantMessage() },
			{ type: "text_delta", contentIndex: 1, delta: "hi", partial: assistantMessage() },
			{ type: "toolcall_delta", contentIndex: 2, delta: "{}", partial: assistantMessage() },
		];
		for (const event of events) {
			handleThinkingPreviewEvent.call(fakeThis, event);
		}
		expect(fakeThis.setDetailSuffix).not.toHaveBeenCalled();
		expect(fakeThis.thinkingPreviewRaw).toBe("");
	});

	test("PIT_NO_THINKING_PREVIEW disables accumulation and the repaint entirely", () => {
		process.env.PIT_NO_THINKING_PREVIEW = "1";
		const fakeThis = makeFakeThis();
		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("this should never show up"));
		expect(fakeThis.setDetailSuffix).not.toHaveBeenCalled();
		expect(fakeThis.thinkingPreviewRaw).toBe("");
	});

	test("clearThinkingPreview forces a visible clear only when something was shown", () => {
		const fakeThis = makeFakeThis();
		// Nothing shown yet: clearing is a no-op push.
		clearThinkingPreview.call(fakeThis);
		expect(fakeThis.setDetailSuffix).not.toHaveBeenCalled();

		handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("some thought"));
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);

		clearThinkingPreview.call(fakeThis);
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(2);
		expect(stripAnsi(String(fakeThis.setDetailSuffix.mock.calls[1]![0]))).toBe("");
		expect(fakeThis.thinkingPreviewRaw).toBe("");
		expect(fakeThis.lastAppliedThinkingPreview).toBe("");
	});

	test("flushThinkingPreview is a no-op without a live loader (nothing to paint onto)", () => {
		const fakeThis = makeFakeThis() as Record<string, unknown>;
		fakeThis.loadingAnimation = undefined;
		expect(() => handleThinkingPreviewEvent.call(fakeThis, thinkingDelta("still accumulates"))).not.toThrow();
		expect(fakeThis.thinkingPreviewRaw).toBe("still accumulates");
	});

	test("thinkingPreviewMaxWidth clamps to the terminal width minus reserved chrome", () => {
		expect(thinkingPreviewMaxWidth.call(makeFakeThis(200))).toBe(70); // capped at 70
		expect(thinkingPreviewMaxWidth.call(makeFakeThis(40))).toBe(16); // floored at 16
		expect(thinkingPreviewMaxWidth.call(makeFakeThis(0))).toBe(70); // no terminal info: fall back to the cap
	});

	test("applyThinkingPreview dedupes against the last value applied to the current loader", () => {
		const fakeThis = makeFakeThis();
		applyThinkingPreview.call(fakeThis, "same tail");
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);
		applyThinkingPreview.call(fakeThis, "same tail");
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);
		applyThinkingPreview.call(fakeThis, "different tail");
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(2);
	});
});

describe("InteractiveMode.handleEvent wires message_update into the thinking preview", () => {
	function makeMessageUpdateFakeThis(columns = 80) {
		const setDetailSuffix = vi.fn();
		return {
			isInitialized: true,
			init: vi.fn(),
			streamingComponent: { updateContent: vi.fn() },
			streamingAttached: false,
			chatContainer: { markChildStale: vi.fn() },
			settingsManager: { getToolActivity: () => "legacy" },
			pendingTools: { has: () => false, get: () => undefined, size: 0 },
			_ensureToolComponent: vi.fn(),
			countAssistantTextChars: () => 0,
			workingMessage: "Thinking…",
			setWorkingPhase: vi.fn(),
			refreshLoaderTrailingSuffix: vi.fn(),
			ui: { requestRender: vi.fn(), terminal: { columns } },
			loadingAnimation: { setDetailSuffix },
			thinkingPreviewRaw: "",
			thinkingPreviewLastAppliedAt: 0,
			lastAppliedThinkingPreview: "",
			handleThinkingPreviewEvent: Reflect.get(InteractiveMode.prototype, "handleThinkingPreviewEvent"),
			applyThinkingPreview: Reflect.get(InteractiveMode.prototype, "applyThinkingPreview"),
			flushThinkingPreview: Reflect.get(InteractiveMode.prototype, "flushThinkingPreview"),
			clearThinkingPreview: Reflect.get(InteractiveMode.prototype, "clearThinkingPreview"),
			thinkingPreviewMaxWidth: Reflect.get(InteractiveMode.prototype, "thinkingPreviewMaxWidth"),
			setDetailSuffix,
		};
	}

	const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
		this: Record<string, unknown>,
		event: unknown,
	) => Promise<void>;

	test("a thinking_delta message_update repaints the loader's thinking tail", async () => {
		const fakeThis = makeMessageUpdateFakeThis();
		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: assistantMessage([{ type: "thinking", thinking: "checking the mtime handling" }]),
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "checking the mtime handling",
				partial: assistantMessage(),
			},
		});
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);
		expect(stripAnsi(String(fakeThis.setDetailSuffix.mock.calls[0]![0]))).toContain("checking the mtime handling");
	});

	test("a text_start message_update clears any live thinking tail", async () => {
		const fakeThis = makeMessageUpdateFakeThis();
		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: assistantMessage([{ type: "thinking", thinking: "reasoning so far" }]),
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: "reasoning so far",
				partial: assistantMessage(),
			},
		});
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(1);

		await handleEvent.call(fakeThis, {
			type: "message_update",
			message: assistantMessage([
				{ type: "thinking", thinking: "reasoning so far" },
				{ type: "text", text: "" },
			]),
			assistantMessageEvent: { type: "text_start", contentIndex: 1, partial: assistantMessage() },
		});
		expect(fakeThis.setDetailSuffix).toHaveBeenCalledTimes(2);
		expect(stripAnsi(String(fakeThis.setDetailSuffix.mock.calls[1]![0]))).toBe("");
	});
});

describe("InteractiveMode.handleEvent wires message_start(assistant) into the thinking preview", () => {
	test("a new assistant stream resets the thinking-preview accumulator before building the component", async () => {
		const chatContainer = { addChild: vi.fn() };
		const clearThinkingPreview = vi.fn();
		const fakeThis = {
			isInitialized: true,
			init: vi.fn(),
			_fusionWriterLoaderActive: false,
			disposeFusionLive: vi.fn(),
			disposeActiveStreamingComponent: vi.fn(),
			clearThinkingPreview,
			hideThinkingBlock: false,
			getMarkdownThemeWithSettings: () => ({}) as unknown,
			hiddenThinkingLabel: "Thinking…",
			ui: { requestRender: vi.fn() },
			settingsManager: {
				getStreamingSmoothing: () => false,
				getAssistantReadingColumns: () => 0,
				getToolActivity: () => "legacy",
			},
			session: { thinkingLevel: "off" as const },
			chatContainer,
			streamingAttached: false,
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: unknown,
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "message_start",
			message: assistantMessage([]),
		});

		expect(clearThinkingPreview).toHaveBeenCalledOnce();
		// Reset happens as part of standing up the new stream, not after.
		expect(fakeThis.disposeActiveStreamingComponent).toHaveBeenCalledOnce();
		expect(chatContainer.addChild).toHaveBeenCalledOnce();
	});
});
