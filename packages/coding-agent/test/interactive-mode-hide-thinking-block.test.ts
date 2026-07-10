import { beforeAll, describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

/**
 * applyHideThinkingBlock() replaces a full rebuildChatFromMessages() with an
 * in-place patch of live AssistantMessageComponent children — EXCEPT in grouped
 * tool-activity mode, where renderSessionContext() decides whether a
 * thinking-only message gets its own bubble at all based on hideThinkingBlock
 * (messageHasVisibleContent), so an in-place patch can't reproduce a
 * bubble appearing/disappearing. See interactive-mode.ts's applyHideThinkingBlock
 * doc comment for the full rationale.
 */
describe("InteractiveMode.applyHideThinkingBlock", () => {
	const applyHideThinkingBlock = Reflect.get(InteractiveMode.prototype, "applyHideThinkingBlock") as (
		this: Record<string, unknown>,
		hidden: boolean,
	) => void;

	test("legacy mode patches existing AssistantMessageComponent children in place, without a rebuild", () => {
		const child = new AssistantMessageComponent();
		const setHideThinkingBlockSpy = vi.spyOn(child, "setHideThinkingBlock");
		const markChildStale = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const requestRender = vi.fn();

		const fakeThis = {
			settingsManager: { getToolActivity: () => "legacy" },
			chatContainer: { children: [child], markChildStale },
			rebuildChatFromMessages,
			ui: { requestRender },
		};

		applyHideThinkingBlock.call(fakeThis, true);

		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(setHideThinkingBlockSpy).toHaveBeenCalledExactlyOnceWith(true);
		expect(markChildStale).toHaveBeenCalledExactlyOnceWith(child);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	test("skips non-AssistantMessageComponent children", () => {
		const other = { setHideThinkingBlock: vi.fn() };
		const markChildStale = vi.fn();

		const fakeThis = {
			settingsManager: { getToolActivity: () => "legacy" },
			chatContainer: { children: [other], markChildStale },
			rebuildChatFromMessages: vi.fn(),
			ui: { requestRender: vi.fn() },
		};

		applyHideThinkingBlock.call(fakeThis, true);

		expect(other.setHideThinkingBlock).not.toHaveBeenCalled();
		expect(markChildStale).not.toHaveBeenCalled();
	});

	test("grouped mode falls back to a full rebuild when thinking-only assistants exist", () => {
		const child = new AssistantMessageComponent();
		const setHideThinkingBlockSpy = vi.spyOn(child, "setHideThinkingBlock");
		const markChildStale = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const requestRender = vi.fn();

		const fakeThis = {
			settingsManager: { getToolActivity: () => "grouped" },
			session: {
				state: {
					messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] }],
				},
			},
			chatContainer: { children: [child], markChildStale },
			rebuildChatFromMessages,
			ui: { requestRender },
		};

		applyHideThinkingBlock.call(fakeThis, true);

		expect(rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		// The in-place patch path (and its own render request) must not also run.
		expect(setHideThinkingBlockSpy).not.toHaveBeenCalled();
		expect(markChildStale).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	test("grouped mode patches in place when every assistant message has visible text", () => {
		const child = new AssistantMessageComponent();
		const setHideThinkingBlockSpy = vi.spyOn(child, "setHideThinkingBlock");
		const markChildStale = vi.fn();
		const rebuildChatFromMessages = vi.fn();
		const requestRender = vi.fn();

		const fakeThis = {
			settingsManager: { getToolActivity: () => "grouped" },
			session: {
				state: {
					messages: [
						{
							role: "assistant",
							content: [
								{ type: "thinking", thinking: "hmm" },
								{ type: "text", text: "answer" },
							],
						},
					],
				},
			},
			chatContainer: { children: [child], markChildStale },
			rebuildChatFromMessages,
			ui: { requestRender },
		};

		applyHideThinkingBlock.call(fakeThis, true);

		expect(rebuildChatFromMessages).not.toHaveBeenCalled();
		expect(setHideThinkingBlockSpy).toHaveBeenCalledExactlyOnceWith(true);
		expect(markChildStale).toHaveBeenCalledExactlyOnceWith(child);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});

/**
 * toggleThinkingBlockVisibility() re-attaches the live streamingComponent after
 * applyHideThinkingBlock() runs, but only when it isn't already a chatContainer
 * child. Legacy mode patches children in place (streamingComponent stays attached
 * from its message_start addChild), so an unconditional addChild would append a
 * SECOND reference and duplicate the streaming message. Grouped mode's rebuild
 * disposes every chat child first, so the guard's includes() check is false and
 * the re-attach must happen. See interactive-mode.ts:~4511-4536.
 */
describe("InteractiveMode.toggleThinkingBlockVisibility", () => {
	const toggleThinkingBlockVisibility = Reflect.get(InteractiveMode.prototype, "toggleThinkingBlockVisibility") as (
		this: Record<string, unknown>,
	) => void;

	function makeStreamingComponent() {
		return {
			setHideThinkingBlock: vi.fn(),
			updateContent: vi.fn(),
		};
	}

	test("legacy mode: does not duplicate an already-attached streaming component", () => {
		const streamingComponent = makeStreamingComponent();
		const children: unknown[] = [streamingComponent]; // already attached from message_start
		const addChild = vi.fn((c: unknown) => children.push(c));
		const streamingMessage = { role: "assistant", content: [] };

		const fakeThis = {
			hideThinkingBlock: false,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			// Legacy mode patches children in place; it never touches chatContainer.children.
			applyHideThinkingBlock: vi.fn(),
			streamingComponent,
			streamingMessage,
			chatContainer: { children, addChild },
			showStatus: vi.fn(),
		};

		toggleThinkingBlockVisibility.call(fakeThis);

		expect(streamingComponent.setHideThinkingBlock).toHaveBeenCalledExactlyOnceWith(true);
		expect(streamingComponent.updateContent).toHaveBeenCalledExactlyOnceWith(streamingMessage);
		expect(addChild).not.toHaveBeenCalled();
		expect(children.filter((c) => c === streamingComponent).length).toBe(1);
	});

	test("grouped mode: re-attaches the streaming component after the rebuild clears the container", () => {
		const streamingComponent = makeStreamingComponent();
		const children: unknown[] = [streamingComponent]; // attached before the toggle
		const addChild = vi.fn((c: unknown) => children.push(c));
		const streamingMessage = { role: "assistant", content: [] };

		const fakeThis = {
			hideThinkingBlock: false,
			settingsManager: { setHideThinkingBlock: vi.fn() },
			// Simulates applyHideThinkingBlock's grouped-mode branch: rebuildChatFromMessages
			// disposes every chat child, so the container comes back empty.
			applyHideThinkingBlock: vi.fn(() => {
				children.length = 0;
			}),
			streamingComponent,
			streamingMessage,
			chatContainer: { children, addChild },
			showStatus: vi.fn(),
		};

		toggleThinkingBlockVisibility.call(fakeThis);

		expect(addChild).toHaveBeenCalledExactlyOnceWith(streamingComponent);
		expect(children.filter((c) => c === streamingComponent).length).toBe(1);
	});
});
