import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function createEditor(text = "next message") {
	return {
		getExpandedText: () => text,
		getText: () => text,
		setText: vi.fn(),
		addToHistory: vi.fn(),
		onSubmit: undefined as ((value: string) => Promise<void>) | undefined,
	};
}

describe("interactive input queue routing", () => {
	test("ordinary Enter queues a follow-up while the agent is working", async () => {
		const editor = createEditor();
		const prompt = vi.fn().mockResolvedValue(undefined);
		const fakeThis = {
			defaultEditor: editor,
			editor,
			clearEphemeralStatus: vi.fn(),
			clearCtrlCHint: vi.fn(),
			isExtensionCommand: vi.fn(() => false),
			dismissStartupScreen: vi.fn(),
			session: { isCompacting: false, isStreaming: true, prompt },
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
			this: typeof fakeThis,
		) => void;

		setup.call(fakeThis);
		await editor.onSubmit?.("next message");

		expect(prompt).toHaveBeenCalledWith("next message", { streamingBehavior: "followUp" });
		expect(editor.setText).toHaveBeenCalledWith("");
		expect(fakeThis.dismissStartupScreen).toHaveBeenCalledOnce();
		expect(fakeThis.updatePendingMessagesDisplay).toHaveBeenCalledOnce();
	});

	test("ordinary Enter queues a follow-up during compaction", async () => {
		const editor = createEditor();
		const queueCompactionMessage = vi.fn();
		const fakeThis = {
			defaultEditor: editor,
			editor,
			clearEphemeralStatus: vi.fn(),
			clearCtrlCHint: vi.fn(),
			isExtensionCommand: vi.fn(() => false),
			dismissStartupScreen: vi.fn(),
			session: { isCompacting: true, isStreaming: false, prompt: vi.fn() },
			queueCompactionMessage,
		};
		const setup = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
			this: typeof fakeThis,
		) => void;

		setup.call(fakeThis);
		await editor.onSubmit?.("after compaction");

		expect(queueCompactionMessage).toHaveBeenCalledWith("after compaction", "followUp");
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	test("steer remains an explicit route for the active turn", async () => {
		const editor = createEditor("focus on tests");
		const prompt = vi.fn().mockResolvedValue(undefined);
		const fakeThis = {
			editor,
			session: { isCompacting: false, isStreaming: true, prompt },
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const handleSteer = Reflect.get(InteractiveMode.prototype, "handleSteer") as (
			this: typeof fakeThis,
			input?: string,
		) => Promise<void>;

		await handleSteer.call(fakeThis, "focus on tests");

		expect(prompt).toHaveBeenCalledWith("focus on tests", { streamingBehavior: "steer" });
		expect(editor.addToHistory).toHaveBeenCalledWith("/steer focus on tests");
		expect(editor.setText).toHaveBeenCalledWith("");
	});
});
