import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

/**
 * ProcessTerminal debounces SIGWINCH "resize" events leading+trailing: the
 * first event of a burst repaints immediately (a drag-resize isn't frozen
 * until the user lets go), later events in the same burst only rearm the
 * trailing timer, and exactly one trailing redraw follows once the burst
 * settles. These tests pin that shape so it can't regress to pure-trailing
 * (frozen during the drag) or to a repaint-per-event flood.
 */

const realStdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;

function stubStdout(): EventEmitter {
	// Only the surface ProcessTerminal.start()/stop() touch: on/removeListener
	// for "resize" and "drain", write() for the various escape-sequence writes.
	const fake = Object.assign(new EventEmitter(), { write: () => true });
	Object.defineProperty(process, "stdout", { value: fake, configurable: true });
	return fake;
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ProcessTerminal resize debounce", () => {
	afterEach(() => {
		Object.defineProperty(process, "stdout", realStdoutDescriptor);
	});

	it("fires the leading event immediately, then exactly one trailing event once a burst settles", async () => {
		const fakeStdout = stubStdout();
		const term = new ProcessTerminal();
		let resizeCount = 0;
		term.start(
			() => {},
			() => {
				resizeCount++;
			},
		);
		try {
			fakeStdout.emit("resize");
			assert.equal(resizeCount, 1, "first event in a burst fires immediately (leading)");
			fakeStdout.emit("resize");
			fakeStdout.emit("resize");
			assert.equal(resizeCount, 1, "events mid-burst are coalesced, not fired immediately");

			await wait(120);
			assert.equal(resizeCount, 2, "burst settles with exactly one trailing redraw");
		} finally {
			term.stop();
		}
	});

	it("does not fire a redundant trailing event for a single isolated resize", async () => {
		const fakeStdout = stubStdout();
		const term = new ProcessTerminal();
		let resizeCount = 0;
		term.start(
			() => {},
			() => {
				resizeCount++;
			},
		);
		try {
			fakeStdout.emit("resize");
			assert.equal(resizeCount, 1);
			await wait(120);
			assert.equal(resizeCount, 1, "an isolated resize should not repaint a second time");
		} finally {
			term.stop();
		}
	});
});
