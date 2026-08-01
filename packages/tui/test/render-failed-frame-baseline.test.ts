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
 * VirtualTerminal whose write() can be armed to throw N times, simulating a
 * burst of downstream write failures (EPIPE on a dying pty, a wedged pipe).
 * doRender's catch swallows each throw and schedules a retry.
 */
class FailingWritesTerminal extends VirtualTerminal {
	private failuresRemaining = 0;

	failNextWrites(count: number): void {
		this.failuresRemaining = count;
	}

	override write(data: string): void {
		if (this.failuresRemaining > 0) {
			this.failuresRemaining -= 1;
			throw new Error("simulated EPIPE");
		}
		super.write(data);
	}
}

describe("diff baseline after a failed frame", () => {
	it("re-emits lines changed in a failed frame instead of declaring them stable", async () => {
		const terminal = new FailingWritesTerminal(40, 10);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		comp.lines = ["a0", "a1", "a2"];
		tui.addChild(comp);

		tui.start();
		await terminal.waitForRender();
		assert.deepEqual((await terminal.flushAndGetViewport()).slice(0, 3), ["a0", "a1", "a2"]);

		// Change a MIDDLE line and fail the next two frames' writes. Two failures
		// pin the failed frame and its retry at the same line count (the retry
		// appends the render-fault banner, the second retry only bumps its
		// counter), which is exactly the shape where a baseline advanced by the
		// failed frame makes applyLineResets declare the changed row "stable" and
		// the last-line diff fast path skips it forever: the row froze on screen.
		// The fix zeroes the baseline in doRender's catch, forcing the recovery
		// frame to run a full scan against the last COMMITTED previousLines.
		comp.lines = ["a0", "a1-changed", "a2"];
		terminal.failNextWrites(2);
		tui.requestRender();

		// The catch retries on its own (~16ms cadence); poll until it settles.
		const deadline = Date.now() + 2000;
		let viewport = await terminal.flushAndGetViewport();
		while (viewport[1] !== "a1-changed" && Date.now() < deadline) {
			await terminal.waitForRender();
			viewport = await terminal.flushAndGetViewport();
		}

		assert.equal(viewport[0], "a0");
		assert.equal(viewport[1], "a1-changed", "row changed in the failed frame must be re-emitted after recovery");
		assert.equal(viewport[2], "a2");

		tui.stop();
	});

	it("keeps rendering correctly on frames after the recovery", async () => {
		const terminal = new FailingWritesTerminal(40, 10);
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		comp.lines = ["b0", "b1", "b2"];
		tui.addChild(comp);

		tui.start();
		await terminal.waitForRender();

		comp.lines = ["b0", "b1-x", "b2"];
		terminal.failNextWrites(2);
		tui.requestRender();
		const deadline = Date.now() + 2000;
		let viewport = await terminal.flushAndGetViewport();
		while (viewport[1] !== "b1-x" && Date.now() < deadline) {
			await terminal.waitForRender();
			viewport = await terminal.flushAndGetViewport();
		}
		assert.equal(viewport[1], "b1-x");

		// A later ordinary change must still diff cleanly from the recovered state.
		comp.lines = ["b0", "b1-x", "b2-y"];
		tui.requestRender();
		await terminal.waitForRender();
		viewport = await terminal.flushAndGetViewport();
		assert.equal(viewport[1], "b1-x");
		assert.equal(viewport[2], "b2-y");

		tui.stop();
	});
});
