/**
 * Editor mouse click → cursor placement (Phase 1: left press only).
 *
 * Most cases drive Editor.onMouse directly with pre-translated (localRow,
 * localCol) — the coordinate space the TUI walker hands a target — after one
 * render() so lastWidth/lastPaddingX/scrollOffset are set. The final case drives
 * the full TUI._handleInputCore path with a raw SGR sequence to prove routing,
 * hit-test, and focus retargeting end-to-end.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import type { MouseEvent } from "../src/keys.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

/** A left mouse press. x/y are unused by onMouse (the walker passes localRow/localCol). */
function leftPress(overrides: Partial<MouseEvent> = {}): MouseEvent {
	return {
		type: "press",
		button: "left",
		wheel: undefined,
		x: 1,
		y: 1,
		shift: false,
		ctrl: false,
		alt: false,
		raw: "",
		...overrides,
	};
}

describe("Editor.onMouse cursor placement", () => {
	it("places the cursor at the clicked column on a one-line prompt (embedded)", () => {
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, { embedded: true });
		editor.setText("hello world");
		editor.render(80);

		// Embedded, no scroll/jump -> headerLines 0, text at localRow 0, paddingX 0.
		assert.equal(editor.onMouse(leftPress(), 0, 6), true);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 6 }); // "hello " | world
	});

	it("declines drag/release with no active gesture and any non-left press", () => {
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, { embedded: true });
		editor.setText("hello");
		editor.render(80);
		// A complete click gesture places the cursor and ends the gesture.
		editor.onMouse(leftPress(), 0, 0);
		editor.onMouse(leftPress({ type: "release" }), 0, 0);
		const before = editor.getCursor();

		// With no gesture in flight, a stray drag/release is declined and moves nothing.
		assert.equal(editor.onMouse(leftPress({ type: "release" }), 0, 3), false);
		assert.equal(editor.onMouse(leftPress({ type: "drag" }), 0, 3), false);
		// A non-left press is always declined.
		assert.equal(editor.onMouse(leftPress({ button: "right" }), 0, 3), false);
		assert.deepEqual(editor.getCursor(), before, "declined events must not move the cursor");
	});

	it("targets the correct wrapped visual line (embedded, char-level wrap)", () => {
		// Width 20 embedded -> layoutWidth 19; a 25-char no-space line wraps into
		// VL0 = chars [0,19), VL1 = chars [19,25).
		const editor = new Editor(createTestTUI(20, 24), defaultEditorTheme, { embedded: true });
		editor.setText("x".repeat(25));
		editor.render(20);

		// Click visual line 1 (localRow 1), column 0 -> logical col 19 (VL1 start).
		assert.equal(editor.onMouse(leftPress(), 1, 0), true);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 19 });

		// Column 3 within VL1 -> logical col 22.
		editor.onMouse(leftPress(), 1, 3);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 22 });
	});

	it("clamps a click past end-of-line to the line end", () => {
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, { embedded: true });
		editor.setText("hello");
		editor.render(80);

		editor.onMouse(leftPress(), 0, 40); // far past the 5-char line
		assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
	});

	it("clamps a click below the text to the last visual line", () => {
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, { embedded: true });
		editor.setText("ab\ncd");
		editor.render(80);

		// localRow 5 is well below the two text rows -> clamp to the last VL (line 1).
		editor.onMouse(leftPress(), 5, 1);
		assert.deepEqual(editor.getCursor(), { line: 1, col: 1 });
	});

	it("subtracts the clamped paddingX from the click column", () => {
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, { embedded: true, paddingX: 2 });
		editor.setText("hello");
		editor.render(80);

		// localCol 5 with paddingX 2 -> content column 3.
		editor.onMouse(leftPress(), 0, 5);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });

		// A click inside the left padding clamps to column 0.
		editor.onMouse(leftPress(), 0, 1);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
	});

	it("is grapheme/wide-safe for CJK (a mid-cell click never splits a wide glyph)", () => {
		// "你好world": 你 cols[0,1], 好 cols[2,3], w=4, o=5, r=6, l=7, d=8.
		// A fresh editor per probe: an adjacent second press would otherwise register
		// as a double-click (word select), which this test isn't exercising.
		const probe = (col: number): { line: number; col: number } => {
			const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, { embedded: true });
			editor.setText("你好world");
			editor.render(80);
			editor.onMouse(leftPress(), 0, col);
			return editor.getCursor();
		};

		assert.deepEqual(probe(0), { line: 0, col: 0 });
		// Middle (right cell) of the first wide char -> strict slice excludes it -> col 0.
		assert.deepEqual(probe(1), { line: 0, col: 0 });
		// Start of 好 -> after 你 (1 code unit) -> col 1.
		assert.deepEqual(probe(2), { line: 0, col: 1 });
		// Start of "world" -> after 你好 -> col 2.
		assert.deepEqual(probe(4), { line: 0, col: 2 });
	});

	it("is grapheme-safe for an astral emoji (surrogate pair counts as its code units)", () => {
		// "a😀b": a col0, 😀 cols[1,2] (length 2), b col3. Fresh editor per probe so the
		// adjacent second press is not read as a double-click.
		const probe = (col: number): { line: number; col: number } => {
			const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, { embedded: true });
			editor.setText("a😀b");
			editor.render(80);
			editor.onMouse(leftPress(), 0, col);
			return editor.getCursor();
		};

		// Right cell of the emoji -> strict excludes it -> col 1 (before the emoji).
		assert.deepEqual(probe(2), { line: 0, col: 1 });
		// Start of "b" -> after "a😀" (1 + 2 code units) -> col 3.
		assert.deepEqual(probe(3), { line: 0, col: 3 });
	});

	it("accounts for the scroll header row and scrollOffset (embedded, scrolled)", () => {
		// 15 lines with the cursor forced to the last one scrolls the 7-row window
		// (rows 24 -> maxVisibleLines 7) to scrollOffset 8, adding a 1-row header.
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, { embedded: true });
		editor.setText(Array.from({ length: 15 }, (_, i) => `L${i}`).join("\n"));
		editor.render(80); // scrollOffset becomes 8, header row appears

		// localRow 1 = first text row = VL (scrollOffset 8 + textRow 0) = logical line 8.
		assert.equal(editor.onMouse(leftPress(), 1, 1), true);
		assert.deepEqual(editor.getCursor(), { line: 8, col: 1 });

		// localRow 3 -> textRow 2 -> logical line 10.
		editor.onMouse(leftPress(), 3, 1);
		assert.deepEqual(editor.getCursor(), { line: 10, col: 1 });

		// A click on the header row (localRow 0) is declined.
		assert.equal(editor.onMouse(leftPress(), 0, 3), false);
	});

	it("accounts for the standalone rule row of a non-embedded editor", () => {
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme); // embedded defaults false
		editor.setText("hello");
		editor.render(80);

		// Non-embedded -> headerLines 1 (the rule). Row 0 is the rule -> declined.
		assert.equal(editor.onMouse(leftPress(), 0, 3), false);
		// Row 1 is the first text row.
		assert.equal(editor.onMouse(leftPress(), 1, 3), true);
		assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
	});
});

describe("Editor mouse click via the full TUI input path (SGR)", () => {
	it("routes an SGR left press to the editor, positions the cursor, and focuses it", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const editor = new Editor(tui, defaultEditorTheme, { embedded: true });
		tui.addChild(editor);
		editor.setText("hello world");
		tui.start();
		await terminal.waitForRender();

		assert.equal(editor.focused, false, "editor starts unfocused");

		// SGR left press at screen cell (x=7, y=1): with the editor as the only,
		// top-of-screen child and short content, screen row 1 -> editor localRow 0,
		// column 7 -> localCol 6 -> logical col 6.
		terminal.sendInput("\x1b[<0;7;1M");

		assert.deepEqual(editor.getCursor(), { line: 0, col: 6 });
		assert.equal(editor.focused, true, "a click focuses the clicked editor");
	});
});
