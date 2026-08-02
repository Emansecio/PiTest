/**
 * In-app text selection over the committed frame (transcript copy).
 *
 * An unclaimed LEFT press over rendered content anchors a selection instead of
 * suspending tracking; drags extend it, the release copies the plain text via
 * onCopySelection, right-click re-copies while highlighted. Wheel/keypress
 * clear it. Native terminal selection stays reachable via shift+drag.
 *
 * Input is driven through the real router (_handleInputCore) so parseMouse +
 * consumeMouse are exercised; the frame is seeded directly (previousLines) so
 * no render pipeline is needed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import { TUI } from "../src/tui.js";
import { paintReverseSpan, stripAnsiCodes } from "../src/utils.js";

class MockTerminal implements Terminal {
	enableCalls = 0;
	disableCalls = 0;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return 80;
	}
	get rows(): number {
		return 24;
	}
	get kittyProtocolActive(): boolean {
		return true;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	enableMouse(): void {
		this.enableCalls++;
	}
	disableMouse(): void {
		this.disableCalls++;
	}
	setMouseEnabled(): void {}
}

function feed(tui: TUI, data: string): void {
	(tui as unknown as { _handleInputCore(data: string): void })._handleInputCore(data);
}

function seedFrame(tui: TUI, lines: string[]): void {
	(tui as unknown as { previousLines: string[] }).previousLines = lines;
}

function makeTui(): { tui: TUI; term: MockTerminal; copies: string[] } {
	const term = new MockTerminal();
	const tui = new TUI(term);
	tui.setMouseEnabled(true);
	const copies: string[] = [];
	tui.onCopySelection = (text) => copies.push(text);
	return { tui, term, copies };
}

// SGR reports are 1-based: press/release button 0, drag = button 0 + 32.
const press = (x: number, y: number) => `\x1b[<0;${x};${y}M`;
const shiftPress = (x: number, y: number) => `\x1b[<4;${x};${y}M`;
const rightPress = (x: number, y: number) => `\x1b[<2;${x};${y}M`;
const drag = (x: number, y: number) => `\x1b[<32;${x};${y}M`;
const release = (x: number, y: number) => `\x1b[<0;${x};${y}m`;
const legacy = (button: number, x: number, y: number, releaseEvent = false) =>
	`\x1b[M${String.fromCharCode((releaseEvent ? 3 : button) + 32)}${String.fromCharCode(x + 32)}${String.fromCharCode(y + 32)}`;

describe("paintReverseSpan / stripAnsiCodes", () => {
	it("wraps the span in reverse video and leaves the rest untouched", () => {
		const painted = paintReverseSpan("hello world", 6, 5);
		assert.equal(painted, "hello \x1b[7mworld\x1b[27m");
	});

	it("re-asserts reverse after an embedded SGR inside the span", () => {
		const painted = paintReverseSpan("ab\x1b[31mcd\x1b[0mef", 0, 6);
		assert.ok(painted.startsWith("\x1b[7m"));
		assert.ok(painted.includes("\x1b[31m\x1b[7m"), "reverse re-asserted after color");
		assert.ok(painted.includes("\x1b[0m\x1b[7m"), "reverse re-asserted after reset");
		assert.equal(stripAnsiCodes(painted), "abcdef");
	});

	it("a span entirely past the text paints nothing", () => {
		assert.equal(paintReverseSpan("short", 40, 10), "short");
	});

	it("stripAnsiCodes removes CSI and OSC sequences", () => {
		assert.equal(stripAnsiCodes("\x1b[31mred\x1b[0m and \x1b]8;;http://x\x07link\x1b]8;;\x07"), "red and link");
	});
});

describe("TUI transcript selection", () => {
	it("unclaimed left press anchors a selection (no suspend); release copies plain text", () => {
		const { tui, term, copies } = makeTui();
		seedFrame(tui, ["hello world", "\x1b[32msecond line\x1b[0m"]);

		feed(tui, press(1, 1));
		assert.equal(term.disableCalls, 0, "selection press must not suspend tracking");

		feed(tui, drag(6, 2));
		feed(tui, release(6, 2));

		assert.deepEqual(copies, ["hello world\nsecond"], "release copies rows 0..1, ANSI stripped, end-inclusive");
	});

	it("right-click while highlighted copies again; a new press clears the selection", () => {
		const { tui, term, copies } = makeTui();
		seedFrame(tui, ["alpha beta", "gamma"]);

		feed(tui, press(1, 1));
		feed(tui, drag(5, 1));
		feed(tui, release(5, 1));
		assert.deepEqual(copies, ["alpha"]);

		feed(tui, rightPress(9, 9));
		assert.deepEqual(copies, ["alpha", "alpha"], "right-click re-copies the highlighted selection");

		// A fresh left press supersedes the old highlight and anchors a new one.
		feed(tui, press(1, 2));
		feed(tui, release(1, 2));
		// Collapsed (no drag): nothing new copied.
		assert.deepEqual(copies, ["alpha", "alpha"]);
		// Right-click with no active selection falls back to the suspend hatch.
		feed(tui, rightPress(9, 9));
		assert.equal(term.disableCalls, 1, "right press with nothing selected suspends (native menu next)");
	});

	it("a keypress clears the highlight; wheel clears and suspends", () => {
		const { tui, term, copies } = makeTui();
		seedFrame(tui, ["some text here"]);

		feed(tui, press(1, 1));
		feed(tui, drag(5, 1));
		feed(tui, release(5, 1));
		assert.equal(copies.length, 1);

		feed(tui, "x");
		feed(tui, rightPress(2, 1));
		assert.equal(copies.length, 1, "keypress cleared the selection, right-click had nothing to copy");

		feed(tui, press(1, 1));
		feed(tui, drag(4, 1));
		feed(tui, "\x1b[<64;5;5M");
		assert.equal(term.disableCalls >= 1, true, "wheel still suspends");
		feed(tui, release(4, 1));
		assert.equal(copies.length, 1, "selection cleared by wheel never copies");
	});

	it("unclaimed left press with an EMPTY frame keeps the legacy suspend behavior", () => {
		const { tui, term } = makeTui();
		feed(tui, press(10, 5));
		assert.equal(term.disableCalls, 1, "nothing rendered → fall back to native selection");
	});

	it("shift+left press leaves selection to the native terminal", () => {
		const { tui, term, copies } = makeTui();
		seedFrame(tui, ["native selection"]);

		feed(tui, shiftPress(1, 1));

		assert.equal(term.disableCalls, 1, "shifted press must suspend in-app tracking");
		assert.deepEqual(copies, []);
		assert.equal((tui as unknown as { textSelection: unknown }).textSelection, null);
	});

	it("routes legacy X10 mouse reports through transcript selection", () => {
		const { tui, copies } = makeTui();
		seedFrame(tui, ["legacy click"]);

		feed(tui, legacy(0, 1, 1));
		feed(tui, legacy(32, 7, 1));
		feed(tui, legacy(0, 7, 1, true));

		assert.deepEqual(copies, ["legacy"]);
	});

	it("normalizes a reverse-direction multiline drag", () => {
		const { tui, copies } = makeTui();
		seedFrame(tui, ["alpha beta", "gamma delta"]);

		feed(tui, press(6, 2));
		feed(tui, drag(7, 1));
		feed(tui, release(7, 1));

		assert.deepEqual(copies, ["beta\ngamma"]);
	});

	it("uses visible columns for ANSI-styled wide Unicode", () => {
		const { tui, copies } = makeTui();
		seedFrame(tui, ["A\x1b[31m🙂\x1b[0mB"]);

		feed(tui, press(2, 1));
		feed(tui, drag(3, 1));
		feed(tui, release(3, 1));

		assert.deepEqual(copies, ["🙂"]);
		assert.equal(stripAnsiCodes(paintReverseSpan("A🙂B", 1, 2)), "A🙂B");
	});

	it("highlight application drops the selection when the frame geometry changed", () => {
		const { tui } = makeTui();
		seedFrame(tui, ["line one", "line two"]);
		feed(tui, press(1, 1));
		feed(tui, drag(8, 2));

		type Private = {
			applyTextSelectionHighlight(lines: string[], width: number): string[];
			textSelection: unknown;
		};
		const internals = tui as unknown as Private;

		// Same geometry: highlight lands on both rows.
		const highlighted = internals.applyTextSelectionHighlight(["line one", "line two"], 80);
		assert.ok(highlighted[0].includes("\x1b[7m"), "first row highlighted");
		assert.ok(highlighted[1].includes("\x1b[7m"), "second row highlighted");

		// Different line count: the selection is dropped, lines untouched.
		const shifted = internals.applyTextSelectionHighlight(["line one", "line two", "line three"], 80);
		assert.deepEqual(shifted, ["line one", "line two", "line three"]);
		assert.equal(internals.textSelection, null, "geometry change cleared the selection");

		const second = makeTui().tui;
		seedFrame(second, ["line one", "line two"]);
		feed(second, press(1, 1));
		feed(second, drag(8, 2));
		const secondInternals = second as unknown as Private;

		const replaced = secondInternals.applyTextSelectionHighlight(["changed!", "line two"], 80);
		assert.deepEqual(replaced, ["changed!", "line two"]);
		assert.equal(secondInternals.textSelection, null, "same-size content change cleared the selection");
	});
});
