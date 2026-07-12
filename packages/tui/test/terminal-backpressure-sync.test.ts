import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

/**
 * ProcessTerminal.write() decides whether a `false` return from
 * process.stdout.write() is REAL backpressure (bytes still buffered, a 'drain'
 * event will come) or a synchronous flush (Windows console / regular file,
 * writableLength already 0, no 'drain' will EVER come). Setting the flag in the
 * synchronous case wedges it forever — nothing but 'drain' clears it — freezing
 * every non-forced render while state keeps updating. These tests pin that
 * decision so the freeze can't regress.
 */

const realDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;

function stubStdout(writeReturn: boolean, writableLength: number): void {
	const fake = {
		write: () => writeReturn,
		writableLength,
		// touched by other ProcessTerminal paths but not by write()
		on: () => fake,
		removeListener: () => fake,
	};
	Object.defineProperty(process, "stdout", { value: fake, configurable: true });
}

describe("ProcessTerminal write() backpressure decision", () => {
	afterEach(() => {
		Object.defineProperty(process, "stdout", realDescriptor);
	});

	it("does NOT mark backpressure when the write flushed synchronously (writableLength 0)", () => {
		const term = new ProcessTerminal();
		stubStdout(false, 0); // Windows console: highWaterMark crossed but already flushed.
		term.write("a big frame that crossed the highWaterMark");
		assert.equal(term.isBackpressured(), false, "sync flush must not wedge the backpressure flag");
	});

	it("DOES mark backpressure when bytes are still buffered (async pipe/socket)", () => {
		const term = new ProcessTerminal();
		stubStdout(false, 4096); // SSH/pipe: genuinely buffered, a 'drain' will follow.
		term.write("a big frame over a slow consumer");
		assert.equal(term.isBackpressured(), true, "real backpressure must still be honored");
	});

	it("does NOT mark backpressure when the write succeeded", () => {
		const term = new ProcessTerminal();
		stubStdout(true, 0);
		term.write("small frame");
		assert.equal(term.isBackpressured(), false);
	});
});
