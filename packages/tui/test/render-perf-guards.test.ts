import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import { deleteKittyImage, encodeKitty, resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.js";
import { type Component, Container, TUI } from "../src/tui.js";

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

	it("uses the last-line-only diff fast path when only the bottom line changes (#C)", () => {
		const terminal = new CollectTerminal(80, 24);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		const N = 200;
		comp.lines = Array.from({ length: N }, (_, i) => `line-${i} ${"x".repeat(16)}`);
		tui.addChild(comp);

		render(tui);

		const tail = comp.lines.slice(0, N - 1);
		comp.lines = [...tail, `${tail.at(-1) ?? ""} spinner`];

		render(tui);

		// Fast path: resetFirstDirty already proved only the last line changed —
		// zero prefix comparisons (O(1)), not N-1.
		assert.strictEqual(
			tui.getDiffScanCountForTest(),
			0,
			"last-line-only change should skip the prefix scan via resetFirstDirty",
		);
	});

	it("falls back to a full diff scan when a non-tail line changes (#C)", () => {
		const terminal = new CollectTerminal(80, 24);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		const N = 200;
		comp.lines = Array.from({ length: N }, (_, i) => `line-${i} ${"x".repeat(16)}`);
		tui.addChild(comp);

		render(tui);

		comp.lines = comp.lines.map((line, i) => (i === 0 ? `${line} changed` : line));

		render(tui);

		assert.strictEqual(
			tui.getDiffScanCountForTest(),
			N + 1,
			"non-tail change uses two-pointer scan (find first from start, last from end), not last-line fast path",
		);
	});
});

/**
 * Child whose render() returns its current `out` array. Reassigning `out`
 * (the way Text/Markdown reallocate on setText) changes the reference, which is
 * the dirty signal Container.render keys on. Counts renders so a test can assert
 * children are still polled every frame (the assertComponentWidth/identity check
 * must keep running even on a cache hit).
 */
class RefChild implements Component {
	out: string[];
	renders = 0;
	constructor(out: string[]) {
		this.out = out;
	}
	render(): string[] {
		this.renders++;
		return this.out;
	}
	invalidate(): void {}
}

describe("Container.render flatten memoization (D2)", () => {
	it("reuses the flattened array by identity when no child changed", () => {
		const container = new Container();
		const a = new RefChild(["a0", "a1"]);
		const b = new RefChild(["b0"]);
		container.addChild(a);
		container.addChild(b);

		const first = container.render(80);
		assert.deepStrictEqual(first, ["a0", "a1", "b0"]);

		const second = container.render(80);
		assert.strictEqual(second, first, "unchanged children should yield the same flattened array instance");
		// Children are still polled each frame (needed for the assert-width guard and
		// the reference comparison), even though the flatten is reused.
		assert.strictEqual(a.renders, 2);
		assert.strictEqual(b.renders, 2);
	});

	it("re-flattens (no stale content) when a child swaps its output array", () => {
		const container = new Container();
		const a = new RefChild(["a0", "a1"]);
		const b = new RefChild(["b0"]);
		container.addChild(a);
		container.addChild(b);

		const first = container.render(80);
		assert.deepStrictEqual(first, ["a0", "a1", "b0"]);

		// Mirror Text/Markdown.setText: reallocate the output array.
		b.out = ["b0-CHANGED", "b1-NEW"];
		const second = container.render(80);
		assert.notStrictEqual(second, first, "a changed child must force a fresh flatten");
		assert.deepStrictEqual(second, ["a0", "a1", "b0-CHANGED", "b1-NEW"]);
	});

	it("re-flattens when width changes even if child array refs are unchanged", () => {
		const container = new Container();
		const a = new RefChild(["a0"]);
		container.addChild(a);

		const w80 = container.render(80);
		const w40 = container.render(40);
		assert.notStrictEqual(w40, w80, "a width change must invalidate the flatten cache");
		assert.deepStrictEqual(w40, ["a0"]);
	});

	it("re-flattens when the child list changes", () => {
		const container = new Container();
		const a = new RefChild(["a0"]);
		container.addChild(a);
		const first = container.render(80);
		assert.deepStrictEqual(first, ["a0"]);

		container.addChild(new RefChild(["b0"]));
		const second = container.render(80);
		assert.deepStrictEqual(second, ["a0", "b0"]);
	});

	it("does not let downstream line-reset mutation corrupt the flatten cache (TUI path)", () => {
		// The TUI mutates the rendered frame (resets/markers). Container.render hands
		// out its memoized array, so if that mutation hit the cache, the second frame
		// would reuse a reset-baked array and double-apply. Drive two real renders and
		// assert the second frame emits the same content as the first for an unchanged child.
		const terminal = new CollectTerminal(40, 6);
		const tui = new TUI(terminal);
		const child = new RefChild(["\x1b[3mItalic line", "plain line"]);
		tui.addChild(child);

		render(tui);
		const firstOut = terminal.output();
		terminal.writes.length = 0;

		// Force another render with no child change (e.g. an unrelated requestRender).
		render(tui);
		const secondOut = terminal.output();

		// Frame 1 painted the content; frame 2 is a no-op diff (nothing changed), so it
		// must NOT re-emit the body lines. A corrupted cache would have changed the
		// stored line bytes and shown a spurious diff.
		assert.ok(firstOut.includes("Italic line"), "first frame paints the content");
		assert.ok(
			!secondOut.includes("Italic line"),
			"second frame must be a no-op diff, not a re-render from a corrupted cache",
		);
	});
});
