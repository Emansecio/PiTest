import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import { deleteKittyImage, encodeKitty, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { type Component, TUI } from "../src/tui.js";

/**
 * Minimal Terminal that records writes without an xterm backend. Lets these
 * guards drive TUI.doRender() synchronously and inspect the emitted bytes.
 */
class CollectTerminal implements Terminal {
	writes: string[] = [];
	private cols: number;
	private rowsCount: number;
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
	output(): string {
		return this.writes.join("");
	}
}

class LinesComponent implements Component {
	lines: string[] = [];
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/** Force a synchronous render, bypassing the throttled scheduler. */
function render(tui: TUI): void {
	(tui as unknown as { doRender(): void }).doRender();
}

describe("render perf guards", () => {
	it("gates the per-line Kitty image scan on terminal capability (#1)", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const terminal = new CollectTerminal(40, 10);
			const tui = new TUI(terminal);
			const comp = new LinesComponent();
			tui.addChild(comp);

			// Inject a Kitty image sequence even though the terminal is non-Kitty.
			// In production these never appear under non-Kitty caps; the scan being
			// gated means TUI emits no image-deletion sequences for them.
			const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
			comp.lines = ["top", oldImage];
			render(tui);
			terminal.writes.length = 0;

			comp.lines = [encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false }), ""];
			render(tui);

			assert.ok(
				!terminal.output().includes(deleteKittyImage(42)),
				"non-Kitty terminal must not scan for / delete Kitty image ids",
			);
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("scales the reset cache to the frame so long transcripts keep ~100% hits (#2)", () => {
		const terminal = new CollectTerminal(80, 24);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		const N = 5000; // > the old fixed 4096 cap
		comp.lines = Array.from({ length: N }, (_, i) => `line-${i} ${"x".repeat(24)}`);
		tui.addChild(comp);

		render(tui);

		const size = tui.getResetCacheSizeForTest();
		// With a frame-scaled cap the whole transcript fits; a fixed 4096 cap would
		// evict its own head every frame and cap the cache below N (0% hit-rate).
		assert.ok(size >= N, `reset cache should hold the whole ${N}-line frame, held ${size}`);
	});
});
