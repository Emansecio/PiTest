import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";
import { ProcessTerminal } from "../src/terminal.js";

/**
 * ProcessTerminal mouse tracking (SGR button-event mode). This PR only wires the
 * enable/disable escapes into start()/stop()/drainInput() behind a per-session flag
 * that defaults OFF — the on-by-default coding-agent wiring lands in a later PR.
 *
 * Test strategy mirrors the existing terminal suites: swap process.stdout for a
 * fake EventEmitter whose write() records the escape strings (as in
 * terminal-resize-debounce.test.ts / stop-cursor-restore.test.ts), run the real
 * ProcessTerminal lifecycle against it, and assert on the recorded sequences.
 * start() still touches the real process.stdin, but every stdin call it makes is
 * guarded (setRawMode) or always-present (setEncoding/resume/on), so this is safe
 * in the node --test environment where stdin is not a TTY.
 */

const ENABLE = "\x1b[?1002h\x1b[?1006h";
const DISABLE = "\x1b[?1002l\x1b[?1006l";
const PASTE_ON = "\x1b[?2004h";

const realStdoutDescriptor = Object.getOwnPropertyDescriptor(process, "stdout")!;

// Terminals started during a test; torn down in afterEach so the real stdin
// listener + unref'd kitty-fallback timer never leak between cases.
const startedTerminals: ProcessTerminal[] = [];

function stubStdout(): string[] {
	const writes: string[] = [];
	const fake = Object.assign(new EventEmitter(), {
		write: (chunk: unknown) => {
			if (typeof chunk === "string") writes.push(chunk);
			return true;
		},
	});
	Object.defineProperty(process, "stdout", { value: fake, configurable: true });
	return writes;
}

function makeTerminal(mouseEnabled = false): ProcessTerminal {
	const term = new ProcessTerminal(mouseEnabled);
	startedTerminals.push(term);
	return term;
}

// Number of times the exact disable pair was emitted (each disableMouse() call
// writes it as one string, so array membership counts the calls that actually wrote).
function disableCount(writes: string[]): number {
	return writes.filter((w) => w === DISABLE).length;
}

describe("ProcessTerminal mouse tracking", () => {
	afterEach(() => {
		// stop() writes to the fake (still installed here) — harmless — and detaches
		// the stdin data handler. Restore the real stdout descriptor afterward.
		for (const term of startedTerminals.splice(0)) term.stop();
		Object.defineProperty(process, "stdout", realStdoutDescriptor);
	});

	it("enabled: start() emits ?1002h?1006h right after ?2004h", () => {
		const writes = stubStdout();
		const term = makeTerminal(true);
		term.start(
			() => {},
			() => {},
		);
		const joined = writes.join("");
		assert.ok(writes.includes(ENABLE), `start() should emit the mouse-enable pair; wrote: ${JSON.stringify(writes)}`);
		assert.ok(joined.includes(PASTE_ON), "start() should still emit bracketed-paste enable");
		assert.ok(
			joined.indexOf(ENABLE) > joined.indexOf(PASTE_ON),
			"mouse enable must come after the bracketed-paste enable",
		);
	});

	it("enabled: stop() emits ?1002l?1006l", () => {
		const writes = stubStdout();
		const term = makeTerminal(true);
		term.start(
			() => {},
			() => {},
		);
		writes.length = 0;
		term.stop();
		assert.ok(
			writes.includes(DISABLE),
			`stop() should emit the mouse-disable pair; wrote: ${JSON.stringify(writes)}`,
		);
	});

	it("enabled: drainInput() emits the disable during the drain", async () => {
		const writes = stubStdout();
		const term = makeTerminal(true);
		term.start(
			() => {},
			() => {},
		);
		writes.length = 0;
		await term.drainInput(20, 5);
		assert.ok(
			writes.includes(DISABLE),
			`drainInput() should emit the mouse-disable pair; wrote: ${JSON.stringify(writes)}`,
		);
	});

	it("disabled (default): start()/stop() emit no mouse sequences", () => {
		const writes = stubStdout();
		const term = makeTerminal(false);
		term.start(
			() => {},
			() => {},
		);
		term.stop();
		const joined = writes.join("");
		assert.ok(!joined.includes("\x1b[?1002"), `no mouse sequence expected; wrote: ${JSON.stringify(writes)}`);
	});

	it("setMouseEnabled(true) after start() turns tracking on immediately", () => {
		const writes = stubStdout();
		const term = makeTerminal(false);
		term.start(
			() => {},
			() => {},
		);
		writes.length = 0;
		term.setMouseEnabled(true);
		assert.ok(
			writes.includes(ENABLE),
			`setMouseEnabled(true) post-start should emit the enable pair; wrote: ${JSON.stringify(writes)}`,
		);
	});

	it("disableMouse() is idempotent (second call writes nothing)", () => {
		const writes = stubStdout();
		const term = makeTerminal(true);
		term.start(
			() => {},
			() => {},
		);
		writes.length = 0;
		term.disableMouse();
		term.disableMouse();
		assert.equal(disableCount(writes), 1, `expected exactly one disable write; wrote: ${JSON.stringify(writes)}`);
	});

	it("stop() then start() with the flag on re-arms tracking", () => {
		const writes = stubStdout();
		const term = makeTerminal(true);
		term.start(
			() => {},
			() => {},
		);
		assert.ok(writes.includes(ENABLE), "first start() should enable tracking");
		term.stop();
		assert.ok(writes.includes(DISABLE), "stop() should disable tracking");
		writes.length = 0;
		term.start(
			() => {},
			() => {},
		);
		assert.ok(
			writes.includes(ENABLE),
			`second start() must re-arm tracking (flag survives stop/start); wrote: ${JSON.stringify(writes)}`,
		);
	});
});
