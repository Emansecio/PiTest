import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.js";
import type { Terminal } from "../src/terminal.js";
import { Container, TUI } from "../src/tui.js";

class NullTerminal implements Terminal {
	private cols: number;
	private rowsCount: number;
	constructor(cols = 100, rowsCount = 40) {
		this.cols = cols;
		this.rowsCount = rowsCount;
	}
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
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

function doRender(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
}

describe("TUI differential render", () => {
	it("only-last-line fast path handles bottom spinner ticks", () => {
		const n = 200;
		const tui = new TUI(new NullTerminal());
		const chat = new Container();
		for (let i = 0; i < n; i++) {
			chat.addChild(new Text(`line ${i}`, 1, 0));
		}
		tui.addChild(chat);
		const spinner = new Text("⠋ Working…", 1, 0);
		tui.addChild(spinner);
		doRender(tui);
		spinner.setText("⠙ Working…");
		doRender(tui);
		const scanCount = (tui as unknown as { getDiffScanCountForTest(): number }).getDiffScanCountForTest();
		assert.ok(scanCount <= 1, `expected O(1) last-line fast path via resetFirstDirty, got ${scanCount} for N=${n}`);
	});
});
