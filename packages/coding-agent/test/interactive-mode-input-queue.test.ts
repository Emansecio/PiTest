import { afterEach, describe, expect, test, vi } from "vitest";
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
	afterEach(() => {
		delete process.env.PIT_NO_SEND_NOW;
	});

	// The Send-now chooser is on by default (see interactive-mode-send-now-chooser
	// test); PIT_NO_SEND_NOW=1 restores the legacy "Enter → followUp direct" path
	// that this test asserts.
	test("ordinary Enter queues a follow-up while the agent is working (legacy path)", async () => {
		process.env.PIT_NO_SEND_NOW = "1";
		const editor = createEditor();
		const prompt = vi.fn().mockResolvedValue(undefined);
		const fakeThis = {
			defaultEditor: editor,
			editor,
			clearEphemeralStatus: vi.fn(),
			clearCtrlCHint: vi.fn(),
			isExtensionCommand: vi.fn(() => false),
			dismissStartupScreen: vi.fn(),
			session: { isCompacting: false, isStreaming: true, isFusing: false, prompt },
			sendNowChooserEnabled: Reflect.get(InteractiveMode.prototype, "sendNowChooserEnabled"),
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

	// Fix 9: a Fusion turn has isStreaming=false but is genuinely busy; steering it
	// must degrade to followUp (identical to the Send-now chooser) instead of the
	// false "no active turn to steer" refusal.
	test("steer during a Fusion turn degrades to followUp with a notice", async () => {
		const editor = createEditor("fusion note");
		const prompt = vi.fn().mockResolvedValue(undefined);
		const showStatus = vi.fn();
		const fakeThis = {
			editor,
			session: { isCompacting: false, isStreaming: false, isFusing: true, prompt },
			updatePendingMessagesDisplay: vi.fn(),
			showStatus,
			ui: { requestRender: vi.fn() },
		};
		const handleSteer = Reflect.get(InteractiveMode.prototype, "handleSteer") as (
			this: typeof fakeThis,
			input?: string,
		) => Promise<void>;

		await handleSteer.call(fakeThis, "fusion note");

		expect(prompt).toHaveBeenCalledWith("fusion note", { streamingBehavior: "followUp" });
		expect(showStatus).toHaveBeenCalledWith("Fusion turn — delivered at end of turn");
		expect(editor.addToHistory).toHaveBeenCalledWith("/steer fusion note");
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	test("steer with no active turn (idle, not fusing) still refuses", async () => {
		const editor = createEditor("nowhere to go");
		const prompt = vi.fn().mockResolvedValue(undefined);
		const showWarning = vi.fn();
		const fakeThis = {
			editor,
			session: { isCompacting: false, isStreaming: false, isFusing: false, prompt },
			updatePendingMessagesDisplay: vi.fn(),
			showWarning,
			ui: { requestRender: vi.fn() },
		};
		const handleSteer = Reflect.get(InteractiveMode.prototype, "handleSteer") as (
			this: typeof fakeThis,
			input?: string,
		) => Promise<void>;

		await handleSteer.call(fakeThis, "nowhere to go");

		expect(prompt).not.toHaveBeenCalled();
		expect(showWarning).toHaveBeenCalledWith("There is no active turn to steer");
		expect(editor.setText).toHaveBeenCalledWith("nowhere to go");
	});
});
