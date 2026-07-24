import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

// H27: Esc during "Thinking…" (before any assistant text) in grouped tool-activity
// mode created the aborted AssistantMessageComponent but never attached it — grouped
// mode defers attach until visible prose, and the aborted branch of message_end froze
// and dropped the component without attaching. Result: the "◦ Operation aborted" notice
// (the ONLY per-message feedback when there are no tool rows) settled invisibly. The fix
// force-attaches the block at message_end for an aborted/error message with no tool calls.

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
	this: Record<string, unknown>,
	event: unknown,
) => Promise<void>;

const abortedErrorMessage = Reflect.get(InteractiveMode.prototype, "_abortedErrorMessage");

function makeFakeThis(overrides: Record<string, unknown> = {}) {
	const streamingComponent = {
		updateContent: vi.fn(),
		setStreamVisible: vi.fn(),
		freeze: vi.fn(),
		dispose: vi.fn(),
	};
	const added: unknown[] = [];
	const fakeThis: Record<string, unknown> = {
		isInitialized: true,
		clearThinkingPreview: vi.fn(),
		gearboxActive: false,
		streamingComponent,
		streamingMessage: undefined,
		streamingAttached: false,
		hideThinkingBlock: true,
		_abortedErrorMessage: abortedErrorMessage,
		session: { retryAttempt: 0 },
		activityStacker: { divide: vi.fn() },
		chatContainer: {
			addChild: vi.fn((child: unknown) => added.push(child)),
			removeChild: vi.fn(),
			markChildStale: vi.fn(),
		},
		pendingTools: new Map(),
		turnOutputTokens: 0,
		lastAssistantComponent: null,
		turnAssistantComponents: [],
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
		...overrides,
	};
	return { fakeThis, streamingComponent, added };
}

describe("H27: aborted bubble attaches in grouped mode when Esc lands during thinking", () => {
	test("thinking-only aborted message force-attaches the streaming block", async () => {
		const { fakeThis, streamingComponent, added } = makeFakeThis();

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "let me consider" }],
				stopReason: "aborted",
			},
		});

		// The block carrying the "◦ Operation aborted" notice was attached to the chat.
		expect(added).toContain(streamingComponent);
		expect(streamingComponent.setStreamVisible).toHaveBeenCalledWith(true);
		expect(streamingComponent.freeze).toHaveBeenCalled();
		expect(fakeThis.streamingAttached).toBe(true);
	});

	test("error thinking-only message also force-attaches", async () => {
		const { fakeThis, streamingComponent, added } = makeFakeThis();

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "…" }],
				stopReason: "error",
				errorMessage: "boom",
			},
		});

		expect(added).toContain(streamingComponent);
	});

	test("already-attached block is not re-attached (legacy / visible-content path)", async () => {
		const { fakeThis, streamingComponent, added } = makeFakeThis({ streamingAttached: true });

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "thinking", thinking: "…" }],
				stopReason: "aborted",
			},
		});

		// Was already attached upstream; the fix must not add it a second time.
		expect(added).not.toContain(streamingComponent);
		expect(streamingComponent.setStreamVisible).not.toHaveBeenCalled();
	});

	test("tool-carrying aborted message is NOT force-attached (tool rows show the error)", async () => {
		const { fakeThis, streamingComponent, added } = makeFakeThis();

		await handleEvent.call(fakeThis, {
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "t1", name: "read", arguments: {} }],
				stopReason: "aborted",
			},
		});

		// With tool calls present the assistant block renders no notice, so attaching an
		// empty block would be noise; the fix leaves it unattached.
		expect(added).not.toContain(streamingComponent);
		expect(fakeThis.streamingAttached).toBe(false);
	});
});
