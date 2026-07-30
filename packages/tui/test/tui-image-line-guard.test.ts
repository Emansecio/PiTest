/**
 * The renderer's one hard rule about images: never on the frame's last line.
 *
 * An image line is opaque here — it is exempt from width measuring and clamping,
 * and the row accounting simply trusts the component to land the cursor back
 * where it started. That trust holds while the drawing stays inside rows the
 * frame owns. On the bottom row there is no row below to absorb a pixel of
 * overflow, so the terminal scrolls to make space — a terminal-side event this
 * renderer cannot observe. Every `previousLines` index is then off by the number
 * of scrolls, and each repaint of a live line (a spinner, an elapsed clock)
 * prints one row lower than the last: the stacked-"Thinking…" corruption.
 *
 * Components keep a spare row under their sprites for exactly this reason. This
 * is the backstop for one that does not.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.js";
import { SIXEL_INTRO } from "../src/sixel.js";
import type { Terminal } from "../src/terminal.js";
import { encodeKitty } from "../src/terminal-image.js";
import { type Component, TUI } from "../src/tui.js";

/** A sixel-shaped payload; only its DCS introducer matters to `isImageLine`. */
const SPRITE = `${SIXEL_INTRO}0;1;0q"1;1;8;6#0;2;0;0;0??????\x1b\\`;

class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	private readonly cols: number;
	private readonly rowsCount: number;
	constructor(cols = 80, rowsCount = 24) {
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
	get output(): string {
		return this.writes.join("");
	}
}

/** Emits a fixed set of lines; the sprite rides on whichever one is last-ish. */
class Lines implements Component {
	private lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	setLines(lines: string[]): void {
		this.lines = lines;
	}
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

function doRender(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
}

describe("trailing image line guard", () => {
	it("drops a sprite that would draw off the last row", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.addChild(new Lines(["transcript", SPRITE]));
		doRender(tui);
		assert.ok(!terminal.output.includes(SIXEL_INTRO), "the bottom-row sprite must not be written");
		assert.ok(terminal.output.includes("transcript"), "the rest of the frame still paints");
		tui.stop();
	});

	it("keeps a sprite that has a row beneath it", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.addChild(new Lines(["transcript", SPRITE, "❯ "]));
		doRender(tui);
		assert.ok(terminal.output.includes(SIXEL_INTRO), "a sprite with slack below it draws normally");
		tui.stop();
	});

	it("keeps the row, so the line count the frame reports is unchanged", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		const lines = new Lines(["a", "b", SPRITE]);
		tui.addChild(lines);
		doRender(tui);
		// The guard blanks the line rather than removing it: a shorter frame would
		// move every row above it and defeat the differential renderer entirely.
		const before = terminal.writes.length;
		lines.setLines(["a", "b", ""]);
		doRender(tui);
		assert.equal(
			terminal.writes.length,
			before,
			"blanked sprite and an actually-blank line are the same frame — nothing to repaint",
		);
		tui.stop();
	});

	it("leaves a bottom-row kitty placement alone", () => {
		// Kitty is addressed in cells and tracked explicitly by the renderer, so it
		// cannot overshoot its rows the way a pixel-addressed sixel can. The guard
		// must not cost it its spot on the last row.
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		const placement = encodeKitty("AAAA", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		tui.addChild(new Lines(["transcript", placement]));
		doRender(tui);
		assert.ok(terminal.output.includes(placement), "kitty placements are exempt");
		tui.stop();
	});

	it("leaves a frame whose last line is plain text alone", () => {
		const terminal = new RecordingTerminal();
		const tui = new TUI(terminal);
		tui.addChild(new Text("just text", 1, 0));
		doRender(tui);
		assert.ok(terminal.output.includes("just text"));
		tui.stop();
	});
});
