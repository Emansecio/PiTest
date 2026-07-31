/**
 * Mouse capture during drag-selection + right-click copy, through the FULL TUI
 * input path (raw SGR sequences → StdinBuffer-shaped events → hit-test).
 *
 * Bug 1 (capture): drag-selection re-hit-tests every drag event at the CURRENT
 * cell, so the moment the pointer wobbles one row off the editor (onto the
 * transcript above or the footer below) the editor stops receiving drags — the
 * selection freezes — and the next drag back over the editor (or nothing at
 * all) applies the final position in one jump. A claimed press must CAPTURE the
 * pointer: all drags/release of that gesture belong to the pressed component,
 * wherever the pointer is.
 *
 * Bug 2 (right-click): with SGR tracking on, the terminal sends right presses
 * to the app instead of doing its own copy — so right-click must copy the
 * active selection via the editor's copySelection hook.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { Text } from "../src/components/text.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

/** SGR report: button code b at 1-based cell (x, y); M = press/drag, m = release. */
const press = (x: number, y: number) => `\x1b[<0;${x};${y}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x};${y}M`;
const release = (x: number, y: number) => `\x1b[<0;${x};${y}m`;
const rightPress = (x: number, y: number) => `\x1b[<2;${x};${y}M`;

async function setup() {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TUI(terminal);
	tui.setMouseEnabled(true);
	// Transcript stand-in above the composer: 3 rows of plain text.
	tui.addChild(new Text("transcript-1\ntranscript-2\ntranscript-3", 0, 0));
	const copied: string[] = [];
	const editor = new Editor(tui, defaultEditorTheme, {
		embedded: true,
		copySelection: (text) => copied.push(text),
	});
	tui.addChild(editor);
	editor.setText("hello world example");
	tui.start();
	await terminal.waitForRender();
	// Frame: rows 1-3 transcript, row 4 the editor's single text line.
	return { terminal, editor, copied };
}

describe("Editor drag-selection with mouse capture (SGR, full path)", () => {
	it("keeps extending the selection while the drag wobbles off the editor row", async () => {
		const { terminal, editor } = await setup();

		terminal.sendInput(press(1, 4)); // anchor at col 0 of "hello world example"
		terminal.sendInput(drag(4, 4)); // head -> col 3 (on the editor row)
		assert.equal(editor.getSelectedText(), "hel");

		// Pointer wobbles one row UP, onto the transcript, while still moving
		// right. Without capture these drags miss the editor and the selection
		// freezes at "hel"; with capture they keep extending it.
		terminal.sendInput(drag(7, 3));
		assert.equal(editor.getSelectedText(), "hello ", "drag above the editor must keep extending the selection");
		terminal.sendInput(drag(12, 2));
		assert.equal(editor.getSelectedText(), "hello world", "drags stay captured while off-component");

		// Release below the editor (footer area) ends the gesture at that column.
		terminal.sendInput(release(12, 10));
		assert.equal(editor.getSelectedText(), "hello world");

		// The gesture is over: a drag after release must not extend anything.
		terminal.sendInput(drag(19, 4));
		assert.equal(editor.getSelectedText(), "hello world");
	});

	it("a plain in-row drag still selects incrementally (regression guard)", async () => {
		const { terminal, editor } = await setup();
		terminal.sendInput(press(1, 4));
		terminal.sendInput(drag(6, 4));
		assert.equal(editor.getSelectedText(), "hello");
		terminal.sendInput(release(6, 4));
		assert.equal(editor.getSelectedText(), "hello");
	});
});

describe("Editor right-click copies the selection (SGR, full path)", () => {
	it("right press with an active selection copies it via copySelection", async () => {
		const { terminal, editor, copied } = await setup();
		terminal.sendInput(press(1, 4));
		terminal.sendInput(drag(6, 4));
		terminal.sendInput(release(6, 4));
		assert.equal(editor.getSelectedText(), "hello");

		terminal.sendInput(rightPress(3, 4));
		assert.deepEqual(copied, ["hello"]);
		// The selection survives the copy — right-click is not a caret move.
		assert.equal(editor.getSelectedText(), "hello");
	});

	it("right press without a selection copies nothing and stays inert", async () => {
		const { terminal, copied } = await setup();
		terminal.sendInput(rightPress(3, 4));
		assert.deepEqual(copied, []);
	});
});
