/**
 * Wheel auto-suspend state machine (TUI).
 *
 * The TUI is inline (no alt-screen), so the emulator scrolls the transcript
 * natively on a wheel gesture. The first wheel report turns SGR tracking OFF
 * (so we don't fight the emulator), and the next non-mouse keypress — or an idle
 * safety timer — turns it back on, but only if the session actually wants mouse.
 *
 * Input is driven through the real router (_handleInputCore) so parseMouse +
 * consumeMouse + the resume-on-keypress hook are all exercised. A mock terminal
 * records enableMouse/disableMouse/setMouseEnabled so the physical writes can be
 * counted without a real TTY.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.js";
import { TUI } from "../src/tui.js";

class MockTerminal implements Terminal {
	enableCalls = 0;
	disableCalls = 0;
	setCalls: boolean[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	get columns(): number {
		return 80;
	}
	get rows(): number {
		return 24;
	}
	get kittyProtocolActive(): boolean {
		return true;
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	enableMouse(): void {
		this.enableCalls++;
	}
	disableMouse(): void {
		this.disableCalls++;
	}
	setMouseEnabled(enabled: boolean): void {
		this.setCalls.push(enabled);
	}
}

const WHEEL_UP = "\x1b[<64;5;5M";
const WHEEL_DOWN = "\x1b[<65;5;5M";

/** Feed a raw sequence through the TUI's real input router. */
function feed(tui: TUI, data: string): void {
	(tui as unknown as { _handleInputCore(data: string): void })._handleInputCore(data);
}

describe("TUI wheel auto-suspend", () => {
	it("suspends tracking on the first wheel report (disableMouse once)", () => {
		const term = new MockTerminal();
		const tui = new TUI(term);
		tui.setMouseEnabled(true);

		feed(tui, WHEEL_UP);
		assert.equal(term.disableCalls, 1, "first wheel disables tracking");
		assert.equal(term.enableCalls, 0, "wheel never re-enables");
	});

	it("does not re-write the disable on a second wheel within the gesture", () => {
		const term = new MockTerminal();
		const tui = new TUI(term);
		tui.setMouseEnabled(true);

		feed(tui, WHEEL_UP);
		feed(tui, WHEEL_DOWN);
		feed(tui, WHEEL_UP);
		assert.equal(term.disableCalls, 1, "already-suspended wheels are idempotent");
	});

	it("suspends on an unclaimed press (transcript/blank area) so the next drag selects natively", () => {
		const term = new MockTerminal();
		const tui = new TUI(term);
		tui.setMouseEnabled(true);

		// Empty TUI: no children, so the press hits nothing (hitTest → null).
		feed(tui, "\x1b[<0;10;5M");
		assert.equal(term.disableCalls, 1, "unclaimed press suspends tracking");
	});

	it("does not suspend on an unclaimed drag/release tail", () => {
		const term = new MockTerminal();
		const tui = new TUI(term);
		tui.setMouseEnabled(true);

		feed(tui, "\x1b[<32;10;5M"); // drag, unclaimed
		feed(tui, "\x1b[<0;10;5m"); // release, unclaimed
		assert.equal(term.disableCalls, 0, "only presses trigger the native-selection escape hatch");
	});

	it("resumes on the next non-mouse keypress when the session wants mouse", () => {
		const term = new MockTerminal();
		const tui = new TUI(term);
		tui.setMouseEnabled(true);

		feed(tui, WHEEL_UP);
		assert.equal(term.enableCalls, 0);
		feed(tui, "a"); // ordinary keypress
		assert.equal(term.enableCalls, 1, "a non-mouse keypress re-arms tracking");

		// A second keypress must not re-enable (no longer suspended).
		feed(tui, "b");
		assert.equal(term.enableCalls, 1);
	});

	it("does not treat a mouse sequence as the resuming keypress", () => {
		const term = new MockTerminal();
		const tui = new TUI(term);
		tui.setMouseEnabled(true);

		feed(tui, WHEEL_UP);
		feed(tui, WHEEL_UP); // still a mouse sequence -> must NOT resume
		assert.equal(term.enableCalls, 0, "another wheel is not a resuming keypress");
	});

	it("never resumes when the session has mouse disabled", () => {
		const term = new MockTerminal();
		const tui = new TUI(term);
		// Session intent left OFF (default). A wheel can still arrive if tracking was
		// briefly on; the keypress must NOT re-enable it.
		feed(tui, WHEEL_UP);
		assert.equal(term.disableCalls, 1);
		feed(tui, "a");
		assert.equal(term.enableCalls, 0, "session-off must never re-enable tracking");
	});

	it("resumes via the idle safety timer if no keypress arrives", (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const term = new MockTerminal();
		const tui = new TUI(term);
		tui.setMouseEnabled(true);

		feed(tui, WHEEL_UP);
		assert.equal(term.enableCalls, 0, "not resumed yet");
		t.mock.timers.tick(500); // idle window elapses
		assert.equal(term.enableCalls, 1, "idle timer re-arms tracking");
	});

	it("setMouseEnabled delegates intent to the terminal and clears any suspension", () => {
		const term = new MockTerminal();
		const tui = new TUI(term);
		tui.setMouseEnabled(true);
		assert.deepEqual(term.setCalls, [true], "intent is delegated to the terminal setter");

		feed(tui, WHEEL_UP); // suspend
		// Re-declaring intent clears the in-flight suspension: a following keypress
		// should not double-resume (enableCalls stays 0 because nothing was suspended).
		tui.setMouseEnabled(true);
		assert.deepEqual(term.setCalls, [true, true]);
		feed(tui, "a");
		assert.equal(term.enableCalls, 0, "no suspension pending after re-declaring intent");
	});
});
