/**
 * Overlay click routing: clicks inside a capturing overlay's composited rect
 * descend the overlay's component tree (SelectList in an overlay is clickable),
 * clicks outside the rect are swallowed (modal semantics — nothing reaches the
 * base content underneath), and unclaimed rows inside the rect are inert.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { SelectList } from "../src/components/select-list.js";
import { Container, TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

const listTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

async function setup() {
	const terminal = new VirtualTerminal(80, 24);
	const tui = new TUI(terminal);
	tui.setMouseEnabled(true);
	const editor = new Editor(tui, defaultEditorTheme, { embedded: true });
	tui.addChild(editor);
	editor.setText("hello world");

	const items = [
		{ value: "alpha", label: "alpha" },
		{ value: "beta", label: "beta" },
		{ value: "gamma", label: "gamma" },
	];
	const list = new SelectList(items, 5, listTheme);
	const confirmed: string[] = [];
	list.onSelect = (item) => confirmed.push(item.value);
	const overlay = new Container();
	overlay.addChild(list);
	// Fixed geometry so the click coordinates below are deterministic:
	// screen rows 5-7 (3 items), columns 10-49.
	tui.showOverlay(overlay, { row: 5, col: 10, width: 40 });

	tui.start();
	await terminal.waitForRender();
	return { terminal, tui, editor, list, confirmed };
}

describe("Overlay mouse routing (SGR)", () => {
	it("routes a click inside the overlay rect to the SelectList item under it", async () => {
		const { terminal, confirmed } = await setup();
		// Overlay row 1 (item "beta") = screen row 6 → SGR y=7; col 10+4 → x=15.
		terminal.sendInput("\x1b[<0;15;7M");
		assert.deepEqual(confirmed, ["beta"]);
	});

	it("swallows clicks outside the overlay rect — the editor below is unreachable", async () => {
		const { terminal, editor, confirmed } = await setup();
		const before = editor.getCursor();
		// Screen cell (x=7, y=1): would hit the editor if no modal were up.
		terminal.sendInput("\x1b[<0;7;1M");
		assert.deepEqual(confirmed, []);
		assert.deepEqual(editor.getCursor(), before);
		assert.equal(editor.focused, false, "modal keeps focus; the click must not retarget it");
	});

	it("clicks on unclaimed rows inside the rect are inert (no confirm, no fall-through)", async () => {
		const { terminal, editor, confirmed } = await setup();
		// Inside the rect horizontally, but below the list's 3 item rows: the
		// Container maps no child there → nothing fires, nothing falls through.
		// (Row space: the overlay is 3 lines tall, so rect rows are exactly the
		// items; click the FIRST row with a non-left button instead.)
		terminal.sendInput("\x1b[<2;15;6M"); // right press on "alpha" row
		assert.deepEqual(confirmed, []);
		assert.equal(editor.focused, false);
	});
});
