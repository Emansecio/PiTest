import { visibleWidth } from "@pit/tui";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { SendNowChooser } from "../src/modes/interactive/components/send-now-chooser.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));

// Byte sequences the TUI delivers for the keys the chooser routes.
const KEY = {
	left: "\x1b[D",
	right: "\x1b[C",
	tab: "\t",
	enter: "\r",
	escape: "\x1b",
} as const;

function proto<T>(name: string): T {
	return Reflect.get(InteractiveMode.prototype, name) as T;
}

function createEditor(text = "next message") {
	// Stateful so setText() round-trips to getText()/getExpandedText(): the chooser
	// empties the composer when it opens and hands the draft back when it closes
	// without sending, so these tests need a composer that remembers.
	let current = text;
	return {
		getExpandedText: () => current,
		getText: () => current,
		setText: vi.fn((value: string) => {
			current = value;
		}),
		addToHistory: vi.fn(),
		// Focusable flag the TUI maintains via setFocus; the chooser listener only
		// claims keys while the composer holds focus. Default: composer focused.
		focused: true,
		onSubmit: undefined as ((value: string) => Promise<void>) | undefined,
	};
}

/** A fakeThis wired with the real chooser methods so they can call each other. */
function createChooserThis(overrides: Record<string, any> = {}): any {
	const editor = createEditor();
	const unsub = vi.fn();
	const fakeThis = {
		editor,
		defaultEditor: editor,
		sendNowChooser: undefined,
		sendNowChooserUnsub: undefined,
		sendNowChooserContainer: { clear: vi.fn(), addChild: vi.fn() },
		session: { isStreaming: true, isFusing: false, prompt: vi.fn().mockResolvedValue(undefined) },
		updatePendingMessagesDisplay: vi.fn(),
		showStatus: vi.fn(),
		ui: { requestRender: vi.fn(), addInputListener: vi.fn(() => unsub) },
		// Real methods under test.
		openSendNowChooser: proto("openSendNowChooser"),
		handleSendNowChooserKey: proto("handleSendNowChooserKey"),
		confirmSendNowChooser: proto("confirmSendNowChooser"),
		cancelSendNowChooser: proto("cancelSendNowChooser"),
		closeSendNowChooser: proto("closeSendNowChooser"),
		restoreSendNowDraft: proto("restoreSendNowDraft"),
		sendNowChooserEnabled: proto("sendNowChooserEnabled"),
		...overrides,
	};
	return { fakeThis, editor, unsub };
}

describe("SendNowChooser component", () => {
	test("navigation cycles the highlight and getSelection reports it", () => {
		const chooser = new SendNowChooser("hello");
		expect(chooser.getSelection()).toBe("send"); // opens on Send now

		chooser.next();
		expect(chooser.getSelection()).toBe("queue");
		chooser.next();
		expect(chooser.getSelection()).toBe("cancel");
		chooser.next();
		expect(chooser.getSelection()).toBe("send"); // wraps

		chooser.prev();
		expect(chooser.getSelection()).toBe("cancel"); // wraps backwards
	});

	test("renders the preview and all three buttons on one content line", () => {
		const chooser = new SendNowChooser("refactor the parser");
		const lines = chooser.render(80);
		expect(lines[0]).toContain("Send now");
		expect(lines[0]).toContain("Queue");
		expect(lines[0]).toContain("Cancel");
		expect(lines[0]).toContain("refactor the parser");
	});

	test("occupies a single row — the hint line is gone", () => {
		expect(new SendNowChooser("hello").render(80)).toHaveLength(1);
	});

	test("labels the actions with the glyphs of the message each one produces", () => {
		const line = new SendNowChooser("hello").render(80)[0] ?? "";
		// ▸ Steer / ◷ Queued in system-message-glyphs.ts.
		expect(line).toContain("▸ Send now");
		expect(line).toContain("◷ Queue");
		expect(line).toContain("✕ Cancel");
	});

	test("carries navigation only — confirm/cancel are what the buttons already say", () => {
		const line = new SendNowChooser("hello").render(80)[0] ?? "";
		expect(line).toContain("←/→");
		expect(line).not.toContain("choose");
		expect(line).not.toContain("confirm");
		expect(line).not.toContain("esc cancel");
	});

	test("row width never shifts as the highlight moves", () => {
		const widths = [0, 1, 2].map((steps) => {
			const chooser = new SendNowChooser("a message worth previewing");
			for (let i = 0; i < steps; i++) chooser.next();
			return visibleWidth(chooser.render(90)[0] ?? "");
		});
		expect(new Set(widths).size).toBe(1);
	});

	test("drops the preview instead of truncating it to noise when space is tight", () => {
		const wide = new SendNowChooser("refactor the parser").render(90)[0] ?? "";
		const narrow = new SendNowChooser("refactor the parser").render(46)[0] ?? "";
		expect(wide).toContain("refactor");
		expect(narrow).not.toContain("r…");
		// The buttons survive intact — they are the part the user has to act on.
		expect(narrow).toContain("Send now");
		expect(narrow).toContain("Cancel");
	});

	test("never overflows the given width", () => {
		for (const width of [120, 80, 60, 46, 38]) {
			const line = new SendNowChooser("some reasonably long pending message").render(width)[0] ?? "";
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

describe("Send-now chooser routing", () => {
	afterEach(() => {
		delete process.env.PIT_NO_SEND_NOW;
	});

	test("Enter during streaming opens the chooser instead of queuing directly", async () => {
		const editor = createEditor();
		const prompt = vi.fn().mockResolvedValue(undefined);
		const openSendNowChooser = vi.fn();
		const fakeThis = {
			defaultEditor: editor,
			editor,
			clearEphemeralStatus: vi.fn(),
			clearCtrlCHint: vi.fn(),
			isExtensionCommand: vi.fn(() => false),
			dismissStartupScreen: vi.fn(),
			session: { isCompacting: false, isStreaming: true, isFusing: false, prompt },
			sendNowChooserEnabled: () => true,
			openSendNowChooser,
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const setup = proto<(this: typeof fakeThis) => void>("setupEditorSubmitHandler");
		setup.call(fakeThis);
		await editor.onSubmit?.("next message");

		expect(openSendNowChooser).toHaveBeenCalledWith("next message");
		expect(prompt).not.toHaveBeenCalled();
	});

	test("PIT_NO_SEND_NOW=1 restores the direct followUp behavior", async () => {
		process.env.PIT_NO_SEND_NOW = "1";
		const editor = createEditor();
		const prompt = vi.fn().mockResolvedValue(undefined);
		const openSendNowChooser = vi.fn();
		const fakeThis = {
			defaultEditor: editor,
			editor,
			clearEphemeralStatus: vi.fn(),
			clearCtrlCHint: vi.fn(),
			isExtensionCommand: vi.fn(() => false),
			dismissStartupScreen: vi.fn(),
			session: { isCompacting: false, isStreaming: true, isFusing: false, prompt },
			sendNowChooserEnabled: proto("sendNowChooserEnabled"),
			openSendNowChooser,
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const setup = proto<(this: typeof fakeThis) => void>("setupEditorSubmitHandler");
		setup.call(fakeThis);
		await editor.onSubmit?.("next message");

		expect(openSendNowChooser).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledWith("next message", { streamingBehavior: "followUp" });
		expect(editor.setText).toHaveBeenCalledWith("");
	});

	test("opening empties the composer — the message shows once, in the chooser", () => {
		const { fakeThis, editor } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "decide about me");

		// The chooser now owns the message; a copy left in the composer read as if it
		// were both awaiting a decision and still being typed.
		expect(editor.setText).toHaveBeenCalledWith("");
		expect(editor.getText()).toBe("");
		expect(fakeThis.sendNowChooserDraft).toBe("decide about me");
		expect(fakeThis.sendNowChooser).toBeInstanceOf(SendNowChooser);
		expect(fakeThis.ui.addInputListener).toHaveBeenCalledOnce();
	});

	test("confirming Send now routes to steer", async () => {
		const { fakeThis, editor } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "read this now");
		editor.setText.mockClear();
		// Highlight defaults to "send".
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("read this now", { streamingBehavior: "steer" });
		expect(editor.addToHistory).toHaveBeenCalledWith("read this now");
		// The composer was already emptied at open time; confirming does not touch it.
		expect(editor.setText).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
		expect(fakeThis.sendNowChooser).toBeUndefined(); // torn down
		// Steer into an active turn → positive mid-turn feedback.
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Will be read at the agent's next step");
	});

	test("confirming Queue routes to followUp", async () => {
		const { fakeThis } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "later please");
		fakeThis.sendNowChooser.next(); // move to Queue
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("later please", { streamingBehavior: "followUp" });
		// Queue during an active turn stays quiet — the pending display already speaks.
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
	});

	test("Cancel hands the draft back to the composer and queues nothing", () => {
		const { fakeThis, editor, unsub } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "never mind");
		editor.setText.mockClear();
		fakeThis.sendNowChooser.next();
		fakeThis.sendNowChooser.next(); // Cancel highlighted

		// Enter on Cancel highlight → cancel path.
		const result = fakeThis.handleSendNowChooserKey.call(fakeThis, KEY.enter);

		expect(result).toEqual({ consume: true });
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("never mind"); // draft returned, intact
		expect(unsub).toHaveBeenCalledOnce();
		expect(fakeThis.sendNowChooser).toBeUndefined();
	});

	test("Esc cancels the chooser and never reaches the turn interrupt", () => {
		const interrupt = vi.fn();
		const { fakeThis } = createChooserThis({
			session: { isStreaming: true, isFusing: false, prompt: vi.fn(), interrupt },
		});
		fakeThis.openSendNowChooser.call(fakeThis, "oops");

		const result = fakeThis.handleSendNowChooserKey.call(fakeThis, KEY.escape);

		expect(result).toEqual({ consume: true }); // consumed → editor.onEscape never runs
		expect(interrupt).not.toHaveBeenCalled();
		expect(fakeThis.sendNowChooser).toBeUndefined();
	});

	test("arrow/Tab keys move the highlight and are consumed", () => {
		const { fakeThis } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "pick one");

		expect(fakeThis.handleSendNowChooserKey.call(fakeThis, KEY.right)).toEqual({ consume: true });
		expect(fakeThis.sendNowChooser.getSelection()).toBe("queue");
		expect(fakeThis.handleSendNowChooserKey.call(fakeThis, KEY.tab)).toEqual({ consume: true });
		expect(fakeThis.sendNowChooser.getSelection()).toBe("cancel");
		expect(fakeThis.handleSendNowChooserKey.call(fakeThis, KEY.left)).toEqual({ consume: true });
		expect(fakeThis.sendNowChooser.getSelection()).toBe("queue");
	});

	test("a printable key restores the draft and passes through to the composer", () => {
		const { fakeThis, editor, unsub } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "typing resumes");

		const result = fakeThis.handleSendNowChooserKey.call(fakeThis, "x");

		expect(result).toBeUndefined(); // not consumed → editor inserts "x" after the draft
		// The restore runs BEFORE the key reaches the editor (global listeners fire
		// first), so typing continues on the draft instead of on an empty composer.
		expect(editor.getText()).toBe("typing resumes");
		expect(unsub).toHaveBeenCalledOnce();
		expect(fakeThis.sendNowChooser).toBeUndefined();
	});

	test("Send now during a Fusion turn degrades to followUp with a notice", async () => {
		const { fakeThis } = createChooserThis({
			session: { isStreaming: false, isFusing: true, prompt: vi.fn().mockResolvedValue(undefined) },
		});
		fakeThis.openSendNowChooser.call(fakeThis, "fusion insight");
		await fakeThis.confirmSendNowChooser.call(fakeThis); // Send now highlighted

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("fusion insight", { streamingBehavior: "followUp" });
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Fusion turn — delivered at end of turn");
	});

	test("confirming after the turn went idle still prompts (fresh turn)", async () => {
		const { fakeThis } = createChooserThis({
			session: { isStreaming: false, isFusing: false, prompt: vi.fn().mockResolvedValue(undefined) },
		});
		fakeThis.openSendNowChooser.call(fakeThis, "delayed decision");
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		// Idle → session.prompt ignores streamingBehavior and starts a normal turn.
		expect(fakeThis.session.prompt).toHaveBeenCalledWith("delayed decision", { streamingBehavior: "steer" });
		expect(fakeThis.showStatus).not.toHaveBeenCalled();
	});

	// Fix 14 (revised): a turn abort can run restoreQueuedMessagesToEditor() while the
	// chooser is open, filling the now-empty composer with the restored queue. The two
	// texts belong to different decisions: the draft goes where the user chose, the
	// restored queue stays in the composer for them to deal with. Neither is lost, and
	// neither is silently swapped for the other.
	test("confirm sends the draft and leaves an abort-restored queue in the composer", async () => {
		const { fakeThis, editor } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "D");
		editor.setText("C"); // turn abort restored queued "C" into the empty composer
		editor.setText.mockClear();
		// Send now highlighted.
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("D", { streamingBehavior: "steer" });
		expect(editor.addToHistory).toHaveBeenCalledWith("D");
		expect(editor.getText()).toBe("C"); // restored queue untouched
		expect(fakeThis.sendNowChooser).toBeUndefined(); // torn down
	});

	test("cancelling after an abort restored the queue appends the draft instead of clobbering it", () => {
		const { fakeThis, editor } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "D");
		editor.setText("C"); // restored queue landed in the composer meanwhile

		fakeThis.handleSendNowChooserKey.call(fakeThis, KEY.escape);

		expect(editor.getText()).toBe("C\n\nD"); // same separator the restore path uses
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	test("confirm with a blank draft cancels instead of sending an empty prompt", async () => {
		const { fakeThis } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "   ");
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		expect(fakeThis.sendNowChooser).toBeUndefined(); // torn down (implicit Cancel)
	});

	// Bug 7: a picker/selector that steals focus must get the keys, not the chooser.
	test("Enter is not consumed and the chooser closes when a picker stole composer focus", () => {
		const { fakeThis, editor, unsub } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "draft for the composer");
		// An agent-driven ask picker / exit_plan approval took focus off the composer.
		editor.focused = false;

		const result = fakeThis.handleSendNowChooserKey.call(fakeThis, KEY.enter);

		// Not consumed → Enter flows through to the focused picker instead of confirming.
		expect(result).toBeUndefined();
		// Chooser torn down (implicit Cancel); nothing was sent as a steer, and the
		// draft is waiting in the composer once the picker is done.
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("draft for the composer");
		expect(unsub).toHaveBeenCalledOnce();
		expect(fakeThis.sendNowChooser).toBeUndefined();
	});

	test("nav keys are still routed while the composer holds focus (regression guard)", () => {
		const { fakeThis } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "pick one");
		// editor.focused defaults to true → the chooser keeps claiming its keys.
		expect(fakeThis.handleSendNowChooserKey.call(fakeThis, KEY.right)).toEqual({ consume: true });
		expect(fakeThis.sendNowChooser.getSelection()).toBe("queue");
	});

	// Bug 8: confirming during post-turn auto-compaction must use the compaction queue.
	test("confirming Send now during compaction queues instead of prompting", async () => {
		const queueCompactionMessage = vi.fn();
		const { fakeThis } = createChooserThis({
			session: {
				isCompacting: true,
				isStreaming: false,
				isFusing: false,
				prompt: vi.fn().mockResolvedValue(undefined),
			},
			queueCompactionMessage,
		});
		fakeThis.openSendNowChooser.call(fakeThis, "compaction-safe message");
		// Send now highlighted → mode "steer".
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(queueCompactionMessage).toHaveBeenCalledWith("compaction-safe message", "steer");
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		expect(fakeThis.sendNowChooser).toBeUndefined(); // chooser still torn down
	});

	test("confirming Queue during compaction queues as followUp instead of prompting", async () => {
		const queueCompactionMessage = vi.fn();
		const { fakeThis } = createChooserThis({
			session: {
				isCompacting: true,
				isStreaming: false,
				isFusing: false,
				prompt: vi.fn().mockResolvedValue(undefined),
			},
			queueCompactionMessage,
		});
		fakeThis.openSendNowChooser.call(fakeThis, "later, after compaction");
		fakeThis.sendNowChooser.next(); // move highlight to Queue
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(queueCompactionMessage).toHaveBeenCalledWith("later, after compaction", "followUp");
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	// The compaction queue path runs the REAL queueCompactionMessage, which clears
	// the composer for ordinary submits — but the chooser's draft never lived
	// there, so a composer refilled mid-chooser (abort → restoreQueuedMessagesToEditor)
	// must survive the confirm. Same contract as the non-compaction path's test above.
	test("confirming during compaction sends the draft and leaves an abort-restored queue in the composer", async () => {
		const { fakeThis, editor } = createChooserThis({
			session: {
				isCompacting: true,
				isStreaming: false,
				isFusing: false,
				prompt: vi.fn().mockResolvedValue(undefined),
			},
			// Real queue path: pushes, writes history, clears the composer, repaints.
			queueCompactionMessage: proto("queueCompactionMessage"),
			compactionQueuedMessages: [],
			persistPendingFollowUps: vi.fn(),
		});
		fakeThis.openSendNowChooser.call(fakeThis, "D");
		editor.setText("C"); // turn abort restored queued "C" into the empty composer

		await fakeThis.confirmSendNowChooser.call(fakeThis); // Send now → steer

		expect(fakeThis.compactionQueuedMessages).toEqual([{ text: "D", mode: "steer" }]);
		expect(editor.addToHistory).toHaveBeenCalledWith("D");
		expect(editor.getText()).toBe("C"); // restored queue untouched
		expect(fakeThis.sendNowChooser).toBeUndefined(); // chooser torn down
	});
});

describe("Alt+Enter stays a direct queue (no chooser)", () => {
	test("handleFollowUp queues followUp during streaming without opening the chooser", async () => {
		const editor = createEditor("explicit queue");
		const prompt = vi.fn().mockResolvedValue(undefined);
		const openSendNowChooser = vi.fn();
		const fakeThis = {
			editor,
			isExtensionCommand: vi.fn(() => false),
			dismissStartupScreen: vi.fn(),
			session: { isCompacting: false, isStreaming: true, isFusing: false, prompt },
			openSendNowChooser,
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const handleFollowUp = proto<(this: typeof fakeThis) => Promise<void>>("handleFollowUp");
		await handleFollowUp.call(fakeThis);

		expect(prompt).toHaveBeenCalledWith("explicit queue", { streamingBehavior: "followUp" });
		expect(openSendNowChooser).not.toHaveBeenCalled();
	});
});
