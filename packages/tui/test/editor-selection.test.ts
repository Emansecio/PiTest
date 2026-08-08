/**
 * Editor mouse selection (Phase 2): drag to select, double-click to select a word,
 * delete/replace the selection, cursor moves / Esc collapse it, reverse-video
 * highlight, and the copySelection callback.
 *
 * Gestures are driven through Editor.onMouse with pre-translated (localRow,
 * localCol) — the coordinate space the TUI walker hands a target — after one
 * render() so lastWidth/lastPaddingX/scrollOffset are set.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { Editor } from "../src/components/editor.js";
import { KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.js";
import type { MouseEvent } from "../src/keys.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TUI(new VirtualTerminal(cols, rows));
}

function mouse(type: MouseEvent["type"], overrides: Partial<MouseEvent> = {}): MouseEvent {
	return {
		type,
		button: type === "release" || type === "drag" ? "left" : "left",
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

function newEditor(cols = 80, rows = 24): Editor {
	return new Editor(createTestTUI(cols, rows), defaultEditorTheme, { embedded: true });
}

describe("Editor selection — press/drag/release", () => {
	it("selects a run on one line (press + drag + release)", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0); // anchor at col 0
		editor.onMouse(mouse("drag"), 0, 5); // head to col 5
		assert.equal(editor.getSelectedText(), "hello");
		assert.equal(editor.hasActiveSelection(), true);

		editor.onMouse(mouse("release"), 0, 5);
		assert.equal(editor.getSelectedText(), "hello", "release keeps a non-empty selection");
	});

	it("selects across multiple logical lines", () => {
		const editor = newEditor();
		editor.setText("abc\ndef\nghi");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 1); // line 0 col 1
		editor.onMouse(mouse("drag"), 2, 2); // line 2 col 2
		editor.onMouse(mouse("release"), 2, 2);

		assert.equal(editor.getSelectedText(), "bc\ndef\ngh");
	});

	it("selects across a wrap boundary within one logical line", () => {
		// Width 20 embedded -> layoutWidth 19; a 25-char no-space line wraps into
		// VL0 chars [0,19), VL1 chars [19,25).
		const editor = newEditor(20, 24);
		editor.setText("x".repeat(25));
		editor.render(20);

		editor.onMouse(mouse("press"), 0, 10); // VL0 col 10
		editor.onMouse(mouse("drag"), 1, 3); // VL1 -> logical col 22
		editor.onMouse(mouse("release"), 1, 3);

		assert.equal(editor.getSelectedText(), "x".repeat(12)); // cols [10,22)
	});

	it("normalizes a backward drag (anchor after head)", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 5); // anchor col 5
		editor.onMouse(mouse("drag"), 0, 1); // head col 1 (anchor > head)
		editor.onMouse(mouse("release"), 0, 1);

		assert.equal(editor.getSelectedText(), "ello"); // cols [1,5)
	});

	it("collapses when release lands on the anchor (a plain click)", () => {
		const editor = newEditor();
		editor.setText("hello");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 3);
		editor.onMouse(mouse("release"), 0, 3);

		assert.equal(editor.hasActiveSelection(), false);
		assert.equal(editor.getSelectedText(), "");
		assert.deepEqual(editor.getCursor(), { line: 0, col: 3 });
	});
});

describe("Editor selection — double-click word select", () => {
	it("selects the word under the pointer", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		// Two presses at the same cell within DOUBLE_CLICK_MS -> word select.
		editor.onMouse(mouse("press"), 0, 2); // inside "hello"
		editor.onMouse(mouse("press"), 0, 2);
		assert.equal(editor.getSelectedText(), "hello");
	});

	it("stops the word at a punctuation boundary", () => {
		const editor = newEditor();
		editor.setText("hello, world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 2); // inside "hello"
		editor.onMouse(mouse("press"), 0, 2);
		assert.equal(editor.getSelectedText(), "hello"); // comma excluded
	});

	it("selects a punctuation run as its own word", () => {
		// "a..b": a0 .1 .2 b3. Click between the dots -> the ".." run.
		const editor = newEditor();
		editor.setText("a..b");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 2);
		editor.onMouse(mouse("press"), 0, 2);
		assert.equal(editor.getSelectedText(), "..");
	});

	it("selects a whole paste marker as one atomic word", () => {
		const editor = newEditor();
		// A >10-line paste inserts a marker like "[paste #1 +12 lines]".
		editor.handleInput(`\x1b[200~${"a\n".repeat(11)}\x1b[201~`);
		editor.render(80);
		const marker = editor.getText();
		assert.match(marker, /^\[paste #1 \+12 lines\]$/);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("press"), 0, 0);
		assert.equal(editor.getSelectedText(), marker);
	});
});

describe("Editor selection — edit operations", () => {
	it("typing over a selection replaces it and one undo restores the original", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 5); // select "hello"
		editor.handleInput("X");

		assert.equal(editor.getText(), "X world");
		assert.equal(editor.hasActiveSelection(), false);

		editor.handleInput("\x1b[45;5u"); // Ctrl+- (undo)
		assert.equal(editor.getText(), "hello world", "a single undo restores the whole pre-replace state");
	});

	it("pasting over a selection replaces it atomically (one undo)", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 6);
		editor.onMouse(mouse("drag"), 0, 11); // select "world"
		editor.handleInput("\x1b[200~there\x1b[201~"); // bracketed paste

		assert.equal(editor.getText(), "hello there");

		editor.handleInput("\x1b[45;5u"); // undo
		assert.equal(editor.getText(), "hello world");
	});

	it("backspace deletes an active selection (one undoable step)", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 5);
		editor.onMouse(mouse("drag"), 0, 11); // select " world"
		editor.handleInput("\x7f"); // Backspace

		assert.equal(editor.getText(), "hello");
		assert.equal(editor.hasActiveSelection(), false);

		editor.handleInput("\x1b[45;5u"); // undo
		assert.equal(editor.getText(), "hello world");
	});

	it("forward-delete deletes an active selection", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 6); // select "hello "
		editor.handleInput("\x1b[3~"); // Delete key

		assert.equal(editor.getText(), "world");
	});
});

describe("Editor selection — collapse on move / Esc", () => {
	it("a cursor move collapses the selection", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 5);
		assert.equal(editor.hasActiveSelection(), true);

		editor.handleInput("\x1b[C"); // Right arrow
		assert.equal(editor.hasActiveSelection(), false);
	});

	it("Esc collapses the selection (base editor)", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 5);
		assert.equal(editor.hasActiveSelection(), true);

		editor.handleInput("\x1b"); // Escape
		assert.equal(editor.hasActiveSelection(), false);
	});

	it("clears the selection on any buffer mutation via setText", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 5);
		assert.equal(editor.hasActiveSelection(), true);

		editor.setText("new text");
		assert.equal(editor.hasActiveSelection(), false);
	});
});

describe("Editor selection — highlight render", () => {
	it("wraps the selected span in reverse video and preserves the plain text", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 5); // select "hello"
		const raw = editor.render(80)[0]!;

		assert.ok(raw.includes("\x1b[7mhello\x1b[0m"), `expected reverse-video "hello", got: ${JSON.stringify(raw)}`);
		assert.equal(stripVTControlCharacters(raw).trimEnd(), "hello world");
	});

	it("highlights a wide-char run without splitting a glyph", () => {
		const editor = newEditor();
		editor.setText("你好world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 4); // cols [0,4) = 你好 (logical [0,2))
		assert.equal(editor.getSelectedText(), "你好");

		const raw = editor.render(80)[0]!;
		assert.ok(raw.includes("\x1b[7m你好\x1b[0m"), `expected reverse-video "你好", got: ${JSON.stringify(raw)}`);
	});

	it("emits no inverse selection SGR under NO_COLOR", () => {
		const previousNoColor = process.env.NO_COLOR;
		const previousForceColor = process.env.FORCE_COLOR;
		process.env.NO_COLOR = "1";
		delete process.env.FORCE_COLOR;
		try {
			const editor = newEditor();
			editor.setText("hello world");
			editor.render(80);
			editor.onMouse(mouse("press"), 0, 0);
			editor.onMouse(mouse("drag"), 0, 5);
			const raw = editor.render(80)[0]!;
			assert.ok(!raw.includes("\x1b[7m"));
			assert.equal(stripVTControlCharacters(raw).trimEnd(), "hello world");
		} finally {
			if (previousNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = previousNoColor;
			if (previousForceColor === undefined) delete process.env.FORCE_COLOR;
			else process.env.FORCE_COLOR = previousForceColor;
		}
	});

	it("has no selection escape once the selection collapses", () => {
		const editor = newEditor();
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 5);
		editor.onMouse(mouse("release"), 0, 5);
		// Collapse via a cursor move, then the highlight is gone.
		editor.handleInput("\x1b[C");
		const raw = editor.render(80)[0]!;
		assert.ok(!raw.includes("\x1b[7mhello"), "no selection highlight after collapse");
	});
});

describe("Editor selection — keyboard", () => {
	it("extends and shrinks with Shift+Arrow", () => {
		const editor = newEditor();
		editor.setText("hello");
		editor.handleInput("\x1b[H");
		editor.handleInput("\x1b[1;2C");
		editor.handleInput("\x1b[1;2C");
		assert.equal(editor.getSelectedText(), "he");
		editor.handleInput("\x1b[1;2D");
		assert.equal(editor.getSelectedText(), "h");
	});

	it("respects remapped keyboard-selection bindings", () => {
		setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.editor.selectRight": "ctrl+x" }));
		try {
			const editor = newEditor();
			editor.setText("hello");
			editor.handleInput("\x1b[H");
			editor.handleInput("\x1b[1;2C");
			assert.equal(editor.getSelectedText(), "");
			editor.handleInput("\x18");
			assert.equal(editor.getSelectedText(), "h");
		} finally {
			setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));
		}
	});

	it("supports Shift+Home/End, word navigation, and PageUp/PageDown", () => {
		const editor = newEditor(80, 10);
		editor.setText("alpha beta\ngamma delta\nthird line\nfourth line\nfifth line\nsixth line");
		editor.handleInput("\x1b[1;2H"); // Shift+Home
		assert.equal(editor.getSelectedText(), "sixth line");
		editor.handleInput("\x1b[1;2F"); // Shift+End shrinks back to the original end
		assert.equal(editor.getSelectedText(), "");
		editor.handleInput("\x1b[1;6D"); // Ctrl+Shift+Left
		assert.equal(editor.getSelectedText(), "line");

		const beforePage = editor.getCursor();
		editor.handleInput("\x1b[5;2~");
		assert.ok(editor.hasActiveSelection());
		assert.notDeepEqual(editor.getCursor(), beforePage);
		editor.handleInput("\x1b[6;2~");
		assert.deepEqual(editor.getCursor(), beforePage);
	});
});

describe("Editor selection — copy callback", () => {
	it("invokes copySelection with the selected text on the copy keybinding", () => {
		const copied: string[] = [];
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, {
			embedded: true,
			copySelection: (text) => copied.push(text),
		});
		editor.setText("hello world");
		editor.render(80);

		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("drag"), 0, 5); // select "hello"
		editor.handleInput("\x1bc"); // alt+c

		assert.deepEqual(copied, ["hello"]);
	});

	it("expands a selected large-paste marker before copying", () => {
		const copied: string[] = [];
		const editor = new Editor(createTestTUI(), defaultEditorTheme, {
			embedded: true,
			copySelection: (text) => copied.push(text),
		});
		const paste = Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n");
		editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
		editor.render(80);
		editor.onMouse(mouse("press"), 0, 0);
		editor.onMouse(mouse("press"), 0, 0);
		editor.handleInput("\x1bc");
		assert.deepEqual(copied, [paste]);
	});

	it("does not fire copySelection when there is no selection", () => {
		const copied: string[] = [];
		const editor = new Editor(createTestTUI(80, 24), defaultEditorTheme, {
			embedded: true,
			copySelection: (text) => copied.push(text),
		});
		editor.setText("hello world");
		editor.render(80);

		editor.handleInput("\x1bc"); // alt+c with no selection
		assert.deepEqual(copied, [], "alt+c is consumed but copies nothing without a selection");
		assert.equal(editor.getText(), "hello world", "alt+c must not leak a character");
	});
});
