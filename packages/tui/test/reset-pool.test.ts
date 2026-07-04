import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Component, TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

class LinesComponent implements Component {
	lines: string[] = [];
	render(): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

/**
 * VirtualTerminal whose write() can be armed to throw exactly once, simulating
 * a downstream failure in the *same* frame that already ran applyLineResets
 * (e.g. a bad terminal.write()). doRender's outer try/catch swallows this, so
 * `previousLines` is never committed for that frame even though the reset
 * double-buffer pool already advanced past it — the exact scenario the
 * pool's collision guard (nextOutput === this.previousLines) exists for.
 */
class ThrowOnWriteTerminal extends VirtualTerminal {
	private shouldFailNextWrite = false;

	armNextWriteFailure(): void {
		this.shouldFailNextWrite = true;
	}

	override write(data: string): void {
		if (this.shouldFailNextWrite) {
			this.shouldFailNextWrite = false;
			throw new Error("simulated downstream render failure");
		}
		super.write(data);
	}
}

describe("applyLineResets double-buffer pooling", () => {
	it("produces correct output across several consecutive single-line changes", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		const n = 6;
		comp.lines = Array.from({ length: n }, (_, i) => `line-${i}`);
		tui.addChild(comp);

		tui.start();
		await terminal.waitForRender();
		let viewport = await terminal.flushAndGetViewport();
		assert.deepEqual(viewport.slice(0, n), comp.lines);

		// Each iteration is a full "rebuild" of applyLineResets (content differs,
		// so the allStable fast path never triggers), forcing the pool to
		// alternate buffers every time: A, B, A, B, ... None of these frames
		// fail, so this is the pool's steady-state (no-collision) path.
		for (let tick = 0; tick < 5; tick++) {
			comp.lines = [...comp.lines.slice(0, n - 1), `line-${n - 1}-tick-${tick}`];
			tui.requestRender();
			await terminal.waitForRender();
			viewport = await terminal.flushAndGetViewport();
			assert.deepEqual(
				viewport.slice(0, n),
				comp.lines,
				`frame ${tick} must show correct content and not a corrupted previousLines`,
			);
		}

		tui.stop();
	});

	it("does not corrupt previousLines when a frame fails downstream of applyLineResets", async () => {
		const terminal = new ThrowOnWriteTerminal(40, 10);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		comp.lines = ["a0", "a1", "a2"];
		tui.addChild(comp);

		tui.start();
		await terminal.waitForRender();
		let viewport = await terminal.flushAndGetViewport();
		assert.deepEqual(viewport.slice(0, 3), ["a0", "a1", "a2"]);

		// Arm a single write failure for the next frame. doRender's catch swallows
		// it and immediately schedules a retry (recordRenderFault + requestRender),
		// so within this waitForRender() the frame may already self-heal — the
		// assertions below only rely on eventual correctness, not on observing the
		// failed frame's frozen state.
		comp.lines = ["a0", "a1", "a2-v2"];
		terminal.armNextWriteFailure();
		tui.requestRender();
		await terminal.waitForRender();

		// Drive a few more real changes on top of the failure. If the pool's
		// collision guard were missing, the failed frame could have left
		// `previousLines` aliased to a buffer that a later frame then mutated in
		// place, corrupting the diff and freezing or garbling the screen.
		comp.lines = ["a0", "a1", "a2-v3"];
		tui.requestRender();
		await terminal.waitForRender();

		comp.lines = ["a0", "a1", "a2-v4"];
		tui.requestRender();
		await terminal.waitForRender();

		viewport = await terminal.flushAndGetViewport();
		assert.deepEqual(viewport.slice(0, 2), ["a0", "a1"], "unrelated lines must remain correct after the failure");
		assert.ok(
			viewport[2].startsWith("a2-v4"),
			`expected the latest content on line 2 after recovery, got ${JSON.stringify(viewport[2])}`,
		);

		tui.stop();
	});
});
