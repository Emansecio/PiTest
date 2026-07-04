import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import { type Component, TUI } from "../src/tui.js";

/**
 * Minimal Terminal that implements the optional backpressure hooks under test
 * control: `setBackpressured()` flips the flag a real ProcessTerminal would
 * flip when process.stdout.write() returns false, and `fireDrain()` mirics
 * the stream's "drain" event (clears the flag, then fires every callback
 * registered via onDrain() exactly once — same one-shot contract as
 * ProcessTerminal's real drain listener).
 */
class FakeTerminal implements Terminal {
	writes: string[] = [];
	private backpressured = false;
	private drainCallbacks: (() => void)[] = [];

	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	get columns(): number {
		return 40;
	}
	get rows(): number {
		return 10;
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

	isBackpressured(): boolean {
		return this.backpressured;
	}
	onDrain(cb: () => void): void {
		this.drainCallbacks.push(cb);
	}

	// Test controls, not part of the Terminal interface.
	setBackpressured(value: boolean): void {
		this.backpressured = value;
	}
	fireDrain(): void {
		this.backpressured = false;
		const callbacks = this.drainCallbacks.splice(0);
		for (const cb of callbacks) cb();
	}
	pendingDrainCallbacks(): number {
		return this.drainCallbacks.length;
	}
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

/** Drive one synchronous render, bypassing the throttled scheduler (same helper pattern as render-perf-guards.test.ts). */
function render(tui: TUI, force = false): void {
	(tui as unknown as { doRender(force?: boolean): void }).doRender(force);
}

describe("TUI backpressure", () => {
	it("skips writing while the terminal is backpressured, registers exactly one drain callback, and paints once drained", () => {
		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		comp.lines = ["hello"];
		tui.addChild(comp);

		terminal.setBackpressured(true);
		render(tui);
		assert.equal(terminal.output(), "", "must not write anything while backpressured");
		assert.equal(terminal.pendingDrainCallbacks(), 1, "should register exactly one drain listener while waiting");

		// A second render attempt while still backpressured must not register a
		// second drain callback (would fire the eventual resume render twice).
		render(tui);
		assert.equal(terminal.pendingDrainCallbacks(), 1, "must not stack a second drain listener");
		assert.equal(terminal.output(), "");

		terminal.fireDrain();
		assert.equal(terminal.pendingDrainCallbacks(), 0, "drain callback is consumed on fire");

		// Simulates the render the drain callback's requestRender() schedules.
		render(tui);
		assert.ok(terminal.output().includes("hello"), "frame should paint once drained");
	});

	it("does not skip a forced render even while backpressured", () => {
		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		comp.lines = ["forced-hello"];
		tui.addChild(comp);

		terminal.setBackpressured(true);
		render(tui, true);

		assert.ok(terminal.output().includes("forced-hello"), "forced render must paint even under backpressure");
		assert.equal(terminal.pendingDrainCallbacks(), 0, "forced path must not register a drain callback");
	});

	it("end-to-end: requestRender() schedules a resume once the real drain callback fires", async () => {
		const terminal = new FakeTerminal();
		const tui = new TUI(terminal);
		const comp = new LinesComponent();
		comp.lines = ["async-hello"];
		tui.addChild(comp);

		terminal.setBackpressured(true);
		tui.requestRender();

		// Poll instead of a fixed sleep: avoids flakiness from the 16ms render
		// throttle on a loaded CI box while keeping the wait bounded.
		const deadline = Date.now() + 2000;
		while (terminal.pendingDrainCallbacks() === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(terminal.output(), "", "still nothing written while backpressured");
		assert.equal(terminal.pendingDrainCallbacks(), 1, "the scheduled render should have registered a drain callback");

		terminal.fireDrain();

		const paintDeadline = Date.now() + 2000;
		while (terminal.output() === "" && Date.now() < paintDeadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(
			terminal.output().includes("async-hello"),
			"drain should trigger the real requestRender -> paint chain",
		);

		tui.stop();
	});
});
