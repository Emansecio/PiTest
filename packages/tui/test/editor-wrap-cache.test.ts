import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.js";
import { TUI } from "../src/tui.js";
import { defaultEditorTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Tall terminal so render() doesn't scroll/clip the drafts we compare.
function tui(cols: number): TUI {
	return new TUI(new VirtualTerminal(cols, 60));
}

function fresh(text: string, cols: number): Editor {
	const e = new Editor(tui(cols), defaultEditorTheme);
	e.setText(text);
	return e;
}

// A long single logical line that must word-wrap at any reasonable width.
const WRAPPING = "the quick brown fox jumps over the lazy dog and then keeps running across the whole field";
// Wide (CJK) content exercises the Intl.Segmenter path the cache memoizes.
const CJK = "你好世界 これはテスト widthひろい 文字 mixed ascii and 全角 characters wrapping over and over";

describe("Editor word-wrap cache", () => {
	it("re-wraps after a width change instead of serving stale chunks", () => {
		const e = fresh(WRAPPING, 80);
		e.render(40); // populate cache at width 40
		const atNarrow = e.render(20); // must re-wrap at 20, not reuse 40
		assert.deepStrictEqual(atNarrow, fresh(WRAPPING, 80).render(20));
	});

	it("produces identical layout to an uncached editor after incremental typing", () => {
		const cols = 32;
		const typed = new Editor(tui(cols), defaultEditorTheme);
		// One wrapping line typed char-by-char: each keystroke grows the line and
		// re-wraps. Final layout must match an uncached editor with the same text.
		const text = `${WRAPPING} ${CJK}`;
		for (const ch of text) {
			typed.handleInput(ch);
		}
		assert.strictEqual(typed.getText(), text);
		assert.deepStrictEqual(typed.render(cols), fresh(text, cols).render(cols));
	});

	it("editing one logical line does not corrupt the others", () => {
		const cols = 28;
		const e = fresh(`${WRAPPING}\nMIDDLE\n${CJK}`, cols);
		e.render(cols); // warm cache for all three lines
		// Cursor is at end (line 3); type into it, then compare to ground truth.
		e.handleInput(" tail");
		assert.deepStrictEqual(e.render(cols), fresh(`${WRAPPING}\nMIDDLE\n${CJK} tail`, cols).render(cols));
	});

	it("render is idempotent (cache returns consistent results)", () => {
		const e = fresh(`${WRAPPING}\n${CJK}`, 30);
		assert.deepStrictEqual(e.render(30), e.render(30));
	});
});
