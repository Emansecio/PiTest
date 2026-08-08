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
		getInterruptiblePendingTools: () => [] as Array<{ id: string; name: string }>,
		attachPastedImagesFor: vi.fn(),
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
		expect(line).toContain("✗ Cancel");
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

// A decoded SGR left-press the TUI mouse router would hand to onMouse.
function leftPress(): any {
	return { type: "press", button: "left", x: 1, y: 1, shift: false, ctrl: false, alt: false, raw: "\x1b[<0;1;1M" };
}

/** Visible column of `label` in the chooser's rendered line (ANSI stripped). */
function columnOf(chooser: SendNowChooser, width: number, label: string): number {
	const plain = (chooser.render(width)[0] ?? "").replace(/\x1b\[[0-9;]*m/g, "");
	const col = plain.indexOf(label);
	expect(col).toBeGreaterThan(-1);
	return col;
}

describe("SendNowChooser mouse", () => {
	test("a left press on each button, where it is actually rendered, selects and fires it", () => {
		for (const [text, width] of [
			["refactor the parser so it handles nested templates", 80], // long preview
			["hi", 80], // short preview — spans must shift left with it
			["refactor the parser", 46], // preview dropped entirely
		] as const) {
			for (const [label, key] of [
				["▸ Send now", "send"],
				["◷ Queue", "queue"],
				["✗ Cancel", "cancel"],
			] as const) {
				const chooser = new SendNowChooser(text);
				const fired: string[] = [];
				chooser.onAction = (selection) => fired.push(selection);
				const handled = chooser.onMouse(leftPress(), 0, columnOf(chooser, width, label));
				expect(handled).toBe(true);
				expect(chooser.getSelection()).toBe(key);
				expect(fired).toEqual([key]);
			}
		}
	});

	test("a press outside the buttons (marker/preview) is declined and fires nothing", () => {
		const chooser = new SendNowChooser("refactor the parser so it handles nested templates");
		const fired: string[] = [];
		chooser.onAction = (selection) => fired.push(selection);
		chooser.render(80);
		// Column 0 is the ▌ gutter marker; column 3 lands inside the preview text.
		expect(chooser.onMouse(leftPress(), 0, 0)).toBe(false);
		expect(chooser.onMouse(leftPress(), 0, 3)).toBe(false);
		expect(fired).toEqual([]);
		expect(chooser.getSelection()).toBe("send"); // highlight untouched
	});

	test("drags, releases and non-left presses are declined", () => {
		const chooser = new SendNowChooser("hello");
		const fired: string[] = [];
		chooser.onAction = (selection) => fired.push(selection);
		const col = columnOf(chooser, 80, "▸ Send now");
		expect(chooser.onMouse({ ...leftPress(), type: "release" }, 0, col)).toBe(false);
		expect(chooser.onMouse({ ...leftPress(), type: "drag" }, 0, col)).toBe(false);
		expect(chooser.onMouse({ ...leftPress(), button: "right" }, 0, col)).toBe(false);
		expect(fired).toEqual([]);
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

	// Fix 14: an extension command prompt()ed mid-turn executes IMMEDIATELY in
	// agent-session (_promptOnce handles it before any queue routing), so both
	// chooser buttons would lie — [Send now] and [Queue] each run it on the spot.
	test("an extension command during streaming dispatches directly, no chooser", async () => {
		const editor = createEditor();
		const prompt = vi.fn().mockResolvedValue(undefined);
		const openSendNowChooser = vi.fn();
		const fakeThis = {
			defaultEditor: editor,
			editor,
			clearEphemeralStatus: vi.fn(),
			clearCtrlCHint: vi.fn(),
			_dispatchSlashCommand: vi.fn().mockResolvedValue(false), // busy → dispatcher refuses it
			_warnIfUnknownCommand: vi.fn(() => false), // registered command, no typo warning
			isExtensionCommand: vi.fn(() => true),
			dismissStartupScreen: vi.fn(),
			session: { isCompacting: false, isStreaming: true, isFusing: false, prompt },
			sendNowChooserEnabled: () => true,
			openSendNowChooser,
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const setup = proto<(this: typeof fakeThis) => void>("setupEditorSubmitHandler");
		setup.call(fakeThis);
		await editor.onSubmit?.("/review src/parser.ts");

		expect(openSendNowChooser).not.toHaveBeenCalled();
		expect(prompt).toHaveBeenCalledWith("/review src/parser.ts", { streamingBehavior: "followUp" });
		expect(editor.addToHistory).toHaveBeenCalledWith("/review src/parser.ts");
		expect(editor.getText()).toBe(""); // composer cleared — the command left for the session
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
			attachPastedImagesFor: vi.fn(),
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

	// The 12-minute-preview bug: a steer is only read at the next step boundary,
	// so a long or hung tool held "Send now" hostage — the message sat queued
	// while the user watched nothing happen. Send now must mean NOW: cancel the
	// in-flight tools (per-tool, the turn stays alive) right after queueing the
	// steer, so the boundary arrives immediately and the message is read.
	test("confirming Send now cancels in-flight tools so the steer lands immediately", async () => {
		const cancelTool = vi.fn((_id: string) => true);
		const prompt = vi.fn().mockResolvedValue(undefined);
		const { fakeThis } = createChooserThis({
			session: { isStreaming: true, isFusing: false, prompt, cancelTool },
			getInterruptiblePendingTools: () => [
				{ id: "tool-1", name: "preview" },
				{ id: "tool-2", name: "bash" },
			],
		});
		fakeThis.openSendNowChooser.call(fakeThis, "stop and read this");
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(prompt).toHaveBeenCalledWith("stop and read this", { streamingBehavior: "steer" });
		expect(cancelTool.mock.calls.map((c) => c[0])).toEqual(["tool-1", "tool-2"]);
		// The steer must be queued BEFORE the tools are cancelled — cancelling first
		// could let the turn reach (or cross) the boundary with nothing queued yet.
		const promptOrder = prompt.mock.invocationCallOrder[0] ?? Number.NaN;
		for (const order of cancelTool.mock.invocationCallOrder) expect(order).toBeGreaterThan(promptOrder);
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Cancelled 2 running tools — reading your message now");
	});

	test("confirming Send now releases the coordinator without cancelling its subagents", async () => {
		const cancelTool = vi.fn((_id: string) => true);
		const prompt = vi.fn().mockResolvedValue(undefined);
		const { fakeThis } = createChooserThis({
			session: { isStreaming: true, isFusing: false, prompt, cancelTool },
			getInterruptiblePendingTools: () => [
				{ id: "coordinator-task", name: "task" },
				{ id: "tool-1", name: "preview" },
			],
		});
		fakeThis.openSendNowChooser.call(fakeThis, "read this without stopping agents");
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(cancelTool).toHaveBeenCalledTimes(2);
		expect(cancelTool).toHaveBeenNthCalledWith(1, "coordinator-task", { preserveCoordinatorChildren: true });
		expect(cancelTool).toHaveBeenNthCalledWith(2, "tool-1");
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Cancelled 2 running tools — reading your message now");
	});

	test("confirming Send now with no tools in flight keeps the boundary wording", async () => {
		const cancelTool = vi.fn(() => true);
		const { fakeThis } = createChooserThis({
			session: { isStreaming: true, isFusing: false, prompt: vi.fn().mockResolvedValue(undefined), cancelTool },
		});
		fakeThis.openSendNowChooser.call(fakeThis, "nothing to cancel");
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(cancelTool).not.toHaveBeenCalled();
		expect(fakeThis.showStatus).toHaveBeenCalledWith("Will be read at the agent's next step");
	});

	test("confirming Queue never cancels in-flight tools", async () => {
		const cancelTool = vi.fn(() => true);
		const { fakeThis } = createChooserThis({
			session: { isStreaming: true, isFusing: false, prompt: vi.fn().mockResolvedValue(undefined), cancelTool },
			getInterruptiblePendingTools: () => [{ id: "tool-1", name: "bash" }],
		});
		fakeThis.openSendNowChooser.call(fakeThis, "later please");
		fakeThis.sendNowChooser.next(); // move to Queue
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(cancelTool).not.toHaveBeenCalled();
	});

	test("a tool that already finished is not counted in the cancel status", async () => {
		// cancelTool returns false when the tool completed between render and click.
		const cancelTool = vi.fn((id: string) => id === "tool-1");
		const { fakeThis } = createChooserThis({
			session: { isStreaming: true, isFusing: false, prompt: vi.fn().mockResolvedValue(undefined), cancelTool },
			getInterruptiblePendingTools: () => [
				{ id: "tool-1", name: "preview" },
				{ id: "tool-2", name: "bash" },
			],
		});
		fakeThis.openSendNowChooser.call(fakeThis, "count honestly");
		await fakeThis.confirmSendNowChooser.call(fakeThis);

		expect(fakeThis.showStatus).toHaveBeenCalledWith("Cancelled 1 running tool — reading your message now");
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

	// The bug this guards: global input listeners see the raw SGR sequence BEFORE
	// the TUI decodes it, and the listener's any-other-key branch turned every
	// click into an implicit Cancel — closing the chooser before the click could
	// reach its onMouse, so "Send now" was unclickable.
	test("a mouse sequence flows through without cancelling the chooser", () => {
		const { fakeThis, editor, unsub } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "click me");

		const result = fakeThis.handleSendNowChooserKey.call(fakeThis, "\x1b[<0;34;52M");

		expect(result).toBeUndefined(); // not consumed → the mouse router decodes it
		expect(fakeThis.sendNowChooser).toBeInstanceOf(SendNowChooser); // still open
		expect(editor.getText()).toBe(""); // draft NOT restored — no implicit Cancel
		expect(unsub).not.toHaveBeenCalled();
		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
	});

	test("clicking Send now confirms via onAction and routes to steer", async () => {
		const { fakeThis } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "read this now");

		const chooser = fakeThis.sendNowChooser as SendNowChooser;
		const handled = chooser.onMouse(leftPress(), 0, columnOf(chooser, 80, "▸ Send now"));
		expect(handled).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 0)); // confirm is async

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("read this now", { streamingBehavior: "steer" });
		expect(fakeThis.sendNowChooser).toBeUndefined(); // torn down
	});

	test("clicking Queue routes to followUp", async () => {
		const { fakeThis } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "later please");

		const chooser = fakeThis.sendNowChooser as SendNowChooser;
		chooser.onMouse(leftPress(), 0, columnOf(chooser, 80, "◷ Queue"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("later please", { streamingBehavior: "followUp" });
	});

	test("clicking Cancel hands the draft back to the composer and queues nothing", async () => {
		const { fakeThis, editor } = createChooserThis();
		fakeThis.openSendNowChooser.call(fakeThis, "never mind");

		const chooser = fakeThis.sendNowChooser as SendNowChooser;
		chooser.onMouse(leftPress(), 0, columnOf(chooser, 80, "✗ Cancel"));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(fakeThis.session.prompt).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("never mind"); // draft returned, intact
		expect(fakeThis.sendNowChooser).toBeUndefined();
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
			attachPastedImagesFor: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const handleFollowUp = proto<(this: typeof fakeThis) => Promise<void>>("handleFollowUp");
		await handleFollowUp.call(fakeThis);

		expect(prompt).toHaveBeenCalledWith("explicit queue", { streamingBehavior: "followUp" });
		expect(openSendNowChooser).not.toHaveBeenCalled();
	});
});
