import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import { ProcessTerminal } from "../src/terminal.js";
import { TUI } from "../src/tui.js";
import { VirtualTerminal } from "./virtual-terminal.js";

describe("ProcessTerminal.stop cursor restoration", () => {
	it("writes the show-cursor sequence as part of teardown", () => {
		const terminal = new ProcessTerminal();
		const originalWrite = process.stdout.write.bind(process.stdout);
		const writes: string[] = [];
		(process.stdout as { write: unknown }).write = ((chunk: unknown) => {
			if (typeof chunk === "string") writes.push(chunk);
			return true;
		}) as typeof process.stdout.write;
		try {
			terminal.stop();
		} finally {
			(process.stdout as { write: unknown }).write = originalWrite;
		}
		assert.ok(
			writes.some((w) => w.includes("\x1b[?25h")),
			`expected stop() to emit the show-cursor sequence; wrote: ${JSON.stringify(writes)}`,
		);
	});
});

describe("TUI.stop reposition guard", () => {
	it("still calls terminal.stop() when the reposition write throws", () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui = new TUI(terminal as unknown as Terminal);

		// Simulate rendered content so the reposition branch runs.
		(tui as unknown as { previousLines: string[] }).previousLines = ["line one", "line two"];
		(tui as unknown as { hardwareCursorRow: number }).hardwareCursorRow = 0;

		let stopCalled = false;
		let cursorShown = false;
		terminal.write = () => {
			throw new Error("EPIPE: half-dead pipe");
		};
		terminal.showCursor = () => {
			cursorShown = true;
		};
		terminal.stop = () => {
			stopCalled = true;
		};

		assert.doesNotThrow(() => tui.stop());
		assert.equal(cursorShown, true, "showCursor() must still run after a throwing reposition write");
		assert.equal(stopCalled, true, "terminal.stop() must still run after a throwing reposition write");
	});
});
