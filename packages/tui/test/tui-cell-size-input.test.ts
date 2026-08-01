import assert from "node:assert";
import { performance } from "node:perf_hooks";
import { afterEach, describe, it } from "node:test";
import {
	areCellDimensionsMeasured,
	getCellDimensions,
	resetCapabilitiesCache,
	resetCellDimensions,
	setCellDimensions,
} from "../src/terminal-image.js";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

class RenderCountingInput implements Component {
	renders = 0;
	text = "";

	render(): string[] {
		this.renders++;
		return [this.text];
	}

	handleInput(data: string): void {
		this.text += data;
	}

	invalidate(): void {}
}

function withImageTerminal<T>(fn: () => T): T {
	const prevTermProgram = process.env.TERM_PROGRAM;
	const prevTerm = process.env.TERM;
	const prevGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR;

	process.env.TERM_PROGRAM = "ghostty";
	delete process.env.TERM;
	delete process.env.GHOSTTY_RESOURCES_DIR;
	resetCapabilitiesCache();

	try {
		return fn();
	} finally {
		if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = prevTermProgram;
		if (prevTerm === undefined) delete process.env.TERM;
		else process.env.TERM = prevTerm;
		if (prevGhosttyResourcesDir === undefined) delete process.env.GHOSTTY_RESOURCES_DIR;
		else process.env.GHOSTTY_RESOURCES_DIR = prevGhosttyResourcesDir;
		resetCapabilitiesCache();
	}
}

describe("TUI cell size responses", () => {
	it("forwards bare escape even when a cell size query was sent at startup", () => {
		withImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b");

			assert.deepStrictEqual(recorder.inputs, ["\x1b"]);
			tui.stop();
		});
	});

	it("consumes cell size responses and still forwards later user input", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(recorder.inputs, []);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });

			terminal.sendInput("q");
			assert.deepStrictEqual(recorder.inputs, ["q"]);
			tui.stop();
		});
	});
});

/**
 * Some terminals (Windows Terminal among them) answer the window-size query but
 * not the cell-size one. Without a measured cell, anything that converts a pixel
 * footprint back into terminal rows — the sixel pets — has to fall back to cells,
 * so deriving the cell from the window size is what keeps the sprite available
 * AND correctly sized there.
 */
describe("TUI window pixel size fallback", () => {
	afterEach(() => resetCellDimensions());

	function startTui(terminal: VirtualTerminal): { tui: TUI; recorder: InputRecorder } {
		const tui = new TUI(terminal);
		const recorder = new InputRecorder();
		tui.setFocus(recorder);
		tui.start();
		return { tui, recorder };
	}

	it("derives the cell size by dividing the text area by rows and columns", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui, recorder } = startTui(terminal);

			terminal.sendInput("\x1b[4;480;800t");

			assert.deepStrictEqual(recorder.inputs, [], "the reply is consumed, not typed");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });
			assert.equal(areCellDimensionsMeasured(), true);
			tui.stop();
		});
	});

	it("yields to the exact cell-size reply whichever order the two arrive in", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui } = startTui(terminal);

			terminal.sendInput("\x1b[6;18;9t"); // exact
			terminal.sendInput("\x1b[4;480;800t"); // derived, arrives second

			assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 }, "exact wins");
			tui.stop();
		});
	});

	it("keeps the built-in guess — unmeasured — when the division degenerates", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui } = startTui(terminal);

			// A terminal answering in characters instead of pixels: 80x24 / 80x24 = 1x1.
			terminal.sendInput("\x1b[4;24;80t");

			assert.equal(areCellDimensionsMeasured(), false, "a nonsense scale is not a measurement");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 });
			tui.stop();
		});
	});

	it("rejects a division that lands past any real font", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui } = startTui(terminal);

			// A terminal reporting the whole window, or the screen, rather than the
			// text area: 3600/24 = 150px per row. Overshooting is the dangerous
			// direction — sprite heights are computed FROM the cell.
			terminal.sendInput("\x1b[4;3600;6000t");

			assert.equal(areCellDimensionsMeasured(), false, "an impossible cell is not a measurement");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 });
			tui.stop();
		});
	});

	it("rejects a division whose axes disagree about the scale", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui } = startTui(terminal);

			// 60px tall and 10px wide: both individually plausible, but no monospace
			// cell is six times taller than it is wide. Padding counted on one axis
			// only, or one axis answered in the wrong unit.
			terminal.sendInput("\x1b[4;1440;800t");

			assert.equal(areCellDimensionsMeasured(), false, "a skewed cell is not a measurement");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 });
			tui.stop();
		});
	});

	it("accepts a tall-but-real HiDPI cell", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui } = startTui(terminal);

			// 40×18: a large font on a scaled display. The plausibility bounds must be
			// loose enough to let this through.
			terminal.sendInput("\x1b[4;960;1440t");

			assert.deepStrictEqual(getCellDimensions(), { widthPx: 18, heightPx: 40 });
			assert.equal(areCellDimensionsMeasured(), true);
			tui.stop();
		});
	});

	it("forwards a window-size-shaped sequence that is not a reply", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui, recorder } = startTui(terminal);

			terminal.sendInput("\x1b[4;480;800m"); // SGR, not a window report
			assert.deepStrictEqual(recorder.inputs, ["\x1b[4;480;800m"]);
			tui.stop();
		});
	});
});

/**
 * A resize can BE a font-size change (Ctrl+scroll, Ctrl+±, a profile switch): same
 * window, different cell, new row/column count. Nothing else invalidates the cell
 * size, so without a re-query the recorded value stays stale AND still flagged as
 * measured — and the sixel pets, whose height is authored in rows and emitted in
 * pixels, size themselves against a cell that no longer exists.
 */
describe("TUI cell size re-query after resize", () => {
	afterEach(() => resetCellDimensions());

	/** Keep the image-capable env in place across awaits (withImageTerminal is sync). */
	async function withImageTerminalAsync(fn: () => Promise<void>): Promise<void> {
		const prevTermProgram = process.env.TERM_PROGRAM;
		const prevTerm = process.env.TERM;
		process.env.TERM_PROGRAM = "ghostty";
		delete process.env.TERM;
		resetCapabilitiesCache();
		try {
			await fn();
		} finally {
			if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = prevTermProgram;
			if (prevTerm === undefined) delete process.env.TERM;
			else process.env.TERM = prevTerm;
			resetCapabilitiesCache();
		}
	}

	/** Record every write while still driving the real emulator. */
	function recordWrites(terminal: VirtualTerminal): string[] {
		const writes: string[] = [];
		const original = terminal.write.bind(terminal);
		terminal.write = (data: string) => {
			writes.push(data);
			original(data);
		};
		return writes;
	}

	const CELL_SIZE_QUERIES = ["\x1b[16t", "\x1b[14t"];

	function queryCount(writes: readonly string[]): number {
		return writes.filter((w) => CELL_SIZE_QUERIES.includes(w)).length;
	}

	it("asks again once the resize settles", async () => {
		await withImageTerminalAsync(async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			tui.start();
			const writes = recordWrites(terminal);

			terminal.resize(100, 30);
			assert.equal(queryCount(writes), 0, "not synchronously — the geometry is still settling");

			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			assert.equal(queryCount(writes), CELL_SIZE_QUERIES.length, "both queries go back out");
			tui.stop();
		});
	});

	it("coalesces a burst of resizes into one query", async () => {
		await withImageTerminalAsync(async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			tui.start();
			const writes = recordWrites(terminal);

			// Dragging a border: many SIGWINCH in quick succession.
			for (let cols = 81; cols <= 90; cols++) terminal.resize(cols, 24);

			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			assert.equal(queryCount(writes), CELL_SIZE_QUERIES.length, "one round of queries, not ten");
			tui.stop();
		});
	});

	it("adopts the new cell size the re-query reports", async () => {
		await withImageTerminalAsync(async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			tui.start();
			terminal.sendInput("\x1b[6;18;9t");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 });

			// The user shrinks the font: the window keeps its size, the cell does not.
			terminal.resize(120, 40);
			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			terminal.sendInput("\x1b[6;12;6t");

			assert.deepStrictEqual(getCellDimensions(), { widthPx: 6, heightPx: 12 }, "the stale cell is replaced");
			tui.stop();
		});
	});

	it("does not fire after stop()", async () => {
		await withImageTerminalAsync(async () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = new TUI(terminal);
			tui.start();
			const writes = recordWrites(terminal);

			terminal.resize(100, 30);
			tui.stop();

			await new Promise<void>((resolve) => setTimeout(resolve, 250));
			assert.equal(queryCount(writes), 0, "a pending re-query must not outlive the TUI");
		});
	});
});

/**
 * scheduleCellSizeRequery re-asks for the cell size after EVERY resize, and the
 * usual answer is the same cell (dragging a border does not change the font).
 * Each reply used to invalidate the entire component tree unconditionally —
 * wiping every render cache and re-lexing the transcript per resize for
 * nothing. The guard: a reply equal to the already-measured cell is a no-op.
 */
describe("TUI cell size reply equality guard", () => {
	afterEach(() => resetCellDimensions());

	function startWithInvalidateSpy(terminal: VirtualTerminal): { tui: TUI; invalidations: () => number } {
		const tui = new TUI(terminal);
		let count = 0;
		const original = tui.invalidate.bind(tui);
		tui.invalidate = () => {
			count++;
			original();
		};
		tui.start();
		return { tui, invalidations: () => count };
	}

	it("invalidates on the first reply even when it equals the built-in guess", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui, invalidations } = startWithInvalidateSpy(terminal);

			assert.equal(areCellDimensionsMeasured(), false);
			terminal.sendInput("\x1b[6;18;9t"); // identical to the 9x18 default guess

			assert.equal(invalidations(), 1, "unmeasured→measured must invalidate: the guess became a measurement");
			assert.equal(areCellDimensionsMeasured(), true);
			tui.stop();
		});
	});

	it("does not invalidate when a re-queried exact reply reports the same cell", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui, invalidations } = startWithInvalidateSpy(terminal);

			terminal.sendInput("\x1b[6;18;9t");
			assert.equal(invalidations(), 1);

			// The post-resize re-query answering with the unchanged cell (the common
			// case: a border drag) must not pay a full-tree invalidate again.
			terminal.sendInput("\x1b[6;18;9t");
			assert.equal(invalidations(), 1, "an identical reply is a no-op");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 });
			tui.stop();
		});
	});

	it("still invalidates when the reply reports a different cell", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui, invalidations } = startWithInvalidateSpy(terminal);

			terminal.sendInput("\x1b[6;18;9t");
			terminal.sendInput("\x1b[6;20;10t"); // a real font change

			assert.equal(invalidations(), 2, "a changed cell must invalidate");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });
			tui.stop();
		});
	});

	it("applies the same guard to the derived (CSI 14 t) fallback", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui, invalidations } = startWithInvalidateSpy(terminal);

			terminal.sendInput("\x1b[4;480;800t"); // derives 10x20
			assert.equal(invalidations(), 1, "first derived measurement invalidates");

			terminal.sendInput("\x1b[4;480;800t");
			assert.equal(invalidations(), 1, "identical derived reply is a no-op");

			terminal.sendInput("\x1b[4;528;880t"); // derives 11x22
			assert.equal(invalidations(), 2, "changed derived cell invalidates");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 11, heightPx: 22 });
			tui.stop();
		});
	});

	it("keeps the exact-beats-derived precedence when the exact reply is skipped as identical", () => {
		withImageTerminal(() => {
			resetCellDimensions();
			const terminal = new VirtualTerminal(80, 24);
			const { tui, invalidations } = startWithInvalidateSpy(terminal);

			terminal.sendInput("\x1b[6;18;9t"); // exact
			terminal.sendInput("\x1b[6;18;9t"); // exact again — guard skips the invalidate…
			terminal.sendInput("\x1b[4;480;800t"); // …but the derived fallback must STILL lose

			assert.deepStrictEqual(getCellDimensions(), { widthPx: 9, heightPx: 18 }, "exact wins");
			assert.equal(invalidations(), 1);
			tui.stop();
		});
	});
});

describe("TUI input rendering", () => {
	it("paints synchronous input on the next tick instead of waiting for the animation throttle", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal);
		const input = new RenderCountingInput();
		tui.addChild(input);
		tui.setFocus(input);
		tui.start();
		await terminal.waitForRender();

		const rendersBeforeInput = input.renders;
		(tui as unknown as { lastRenderAt: number }).lastRenderAt = performance.now();
		terminal.sendInput("a");
		terminal.sendInput("b");
		await new Promise<void>((resolve) => process.nextTick(resolve));

		assert.equal(input.text, "ab");
		assert.equal(input.renders, rendersBeforeInput + 1, "same-tick input should coalesce into one immediate paint");
		tui.stop();
	});
});
