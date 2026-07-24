import { describe, expect, test, vi } from "vitest";

// beginSnapshotTurn touches real snapshot state; stub it so the normal-submission path
// can run under a fake `this` without a live session on disk.
vi.mock("../src/core/file-snapshots.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/file-snapshots.ts")>();
	return { ...actual, beginSnapshotTurn: vi.fn() };
});

import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";

// H26: `session.isStreaming` only flips true deep inside agent.run(), several awaits
// after prompt() is called. Two rapid Enters could BOTH pass the isStreaming/isFusing
// busy-check before the first turn was observably streaming; the second then called
// session.prompt() with no streamingBehavior, which throws "Agent is already
// processing" — and the editor already cleared its buffer in submitValue(), so the
// user's text was lost. The `submitStarting` latch closes that window.

const setupEditorSubmitHandler = Reflect.get(InteractiveMode.prototype, "setupEditorSubmitHandler") as (
	this: Record<string, unknown>,
) => void;

function makeFakeThis(overrides: Record<string, unknown> = {}) {
	const editor = {
		onSubmit: undefined as unknown,
		addToHistory: vi.fn(),
		setText: vi.fn(),
		getText: () => "",
	};
	const fakeThis: Record<string, unknown> = {
		defaultEditor: editor,
		editor,
		submitStarting: false,
		workingVisible: false,
		loadingAnimation: undefined,
		onInputCallback: undefined,
		clearEphemeralStatus: vi.fn(),
		clearCtrlCHint: vi.fn(),
		isExtensionCommand: () => false,
		dismissStartupScreen: vi.fn(),
		flushPendingBashComponents: vi.fn(),
		sendNowChooserEnabled: () => true,
		openSendNowChooser: vi.fn(),
		updatePendingMessagesDisplay: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
		session: {
			sessionId: "s1",
			isStreaming: false,
			isFusing: false,
			isCompacting: false,
			prompt: vi.fn(async () => {}),
		},
		...overrides,
	};
	setupEditorSubmitHandler.call(fakeThis);
	const onSubmit = editor.onSubmit as (text: string) => Promise<void>;
	return { fakeThis, onSubmit, editor };
}

describe("H26: double-Enter submit mutex", () => {
	test("a second plain submit while a turn is starting routes to the Send-now chooser, not a bare prompt", async () => {
		// submitStarting preset simulates the window after Enter#1 called prompt() but
		// before isStreaming flipped.
		const { fakeThis, onSubmit } = makeFakeThis({ submitStarting: true });

		await onSubmit("world");

		// Routed to the chooser (which re-seats the text) — NOT dropped into a concurrent
		// prompt() that would throw "already processing".
		expect(fakeThis.openSendNowChooser).toHaveBeenCalledWith("world");
		expect((fakeThis.session as { prompt: ReturnType<typeof vi.fn> }).prompt).not.toHaveBeenCalled();
	});

	test("the normal-submission path latches submitStarting across the prompt() await", async () => {
		let resolvePrompt: (() => void) | undefined;
		const prompt = vi.fn(
			() =>
				new Promise<void>((r) => {
					resolvePrompt = r;
				}),
		);
		const { fakeThis, onSubmit } = makeFakeThis({
			session: {
				sessionId: "s1",
				isStreaming: false,
				isFusing: false,
				isCompacting: false,
				prompt,
			},
		});

		const pending = onSubmit("hello");
		// Synchronously after the first await we should be latched, even though
		// session.isStreaming is still false.
		expect(fakeThis.submitStarting).toBe(true);
		expect(prompt).toHaveBeenCalledWith("hello");

		resolvePrompt?.();
		await pending;
		// Cleared once the turn's prompt() settles.
		expect(fakeThis.submitStarting).toBe(false);
	});

	test("the latch clears even when prompt() throws (text-loss guard stays armed for next turn)", async () => {
		const prompt = vi.fn(async () => {
			throw new Error("Agent is already processing");
		});
		const { fakeThis, onSubmit } = makeFakeThis({
			session: { sessionId: "s1", isStreaming: false, isFusing: false, isCompacting: false, prompt },
		});

		await onSubmit("hello");

		expect(fakeThis.showError).toHaveBeenCalled();
		expect(fakeThis.submitStarting).toBe(false);
	});
});
