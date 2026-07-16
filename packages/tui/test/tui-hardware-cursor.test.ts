import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import type { Component, TUI as TUIType } from "../src/tui.js";
import { CURSOR_MARKER, TUI } from "../src/tui.js";

/**
 * With PIT_HARDWARE_CURSOR on, positionHardwareCursor's escapes (movement +
 * show/hide) must land INSIDE the \x1b[?2026h/l synchronized-update bracket
 * of the frame that produced them - writing them as a separate write() call
 * after the bracket closed let the hardware cursor visibly land at the end
 * of the content for one frame before jumping to its real position. They
 * must also dedupe: \x1b[?25h/l should only appear when visibility changes,
 * not on every frame.
 */

class RecordingTerminal implements Terminal {
	writes: string[] = [];
	private cols: number;
	private rowsCount: number;
	constructor(cols = 40, rowsCount = 10) {
		this.cols = cols;
		this.rowsCount = rowsCount;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	get columns(): number {
		return this.cols;
	}
	get rows(): number {
		return this.rowsCount;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

class MarkerLine implements Component {
	text = "line0";
	focused = true;
	render(_width: number): string[] {
		return [this.text, this.focused ? `x${CURSOR_MARKER}` : "x"];
	}
	invalidate(): void {}
}

function doRender(tui: TUIType): void {
	(tui as unknown as { doRender(): void }).doRender();
}

describe("TUI hardware cursor positioning", () => {
	it("embeds cursor position/visibility inside the bracket on the first (full) render", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal, true);
		tui.addChild(new MarkerLine());

		doRender(tui);

		assert.ok(terminal.writes.length > 0, "expected at least one write");
		const last = terminal.writes[terminal.writes.length - 1]!;
		assert.ok(last.endsWith("\x1b[?2026l"), `frame should close with the sync bracket: ${JSON.stringify(last)}`);
		const closeIndex = last.indexOf("\x1b[?2026l");
		const showIndex = last.indexOf("\x1b[?25h");
		assert.ok(
			showIndex !== -1 && showIndex < closeIndex,
			`cursor show must appear before the bracket closes: ${JSON.stringify(last)}`,
		);
	});

	it("does not re-emit the visibility escape on an unchanged frame", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal, true);
		tui.addChild(new MarkerLine());
		doRender(tui);
		terminal.writes.length = 0;

		doRender(tui); // nothing changed: same content, same cursor row/col

		assert.equal(terminal.writes.length, 1, "still repositions the cursor column, but nothing else");
		assert.ok(!terminal.writes[0]!.includes("\x1b[?25h"), "visibility must not be re-sent when unchanged");
	});

	it("embeds the cursor escape inside the bracket on a differential (non-full) render too", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal, true);
		const comp = new MarkerLine();
		tui.addChild(comp);
		doRender(tui);
		terminal.writes.length = 0;

		comp.text = "line0 changed";
		doRender(tui);

		assert.equal(terminal.writes.length, 1, "the differential path writes its whole frame in one call");
		const last = terminal.writes[0]!;
		assert.ok(last.startsWith("\x1b[?2026h"), "differential frame should open the sync bracket");
		assert.ok(
			last.endsWith("\x1b[?2026l"),
			`differential frame should close with the sync bracket: ${JSON.stringify(last)}`,
		);
		assert.ok(!last.includes("\x1b[?25h"), "visibility unchanged (already shown) must not be re-sent");
	});
});
