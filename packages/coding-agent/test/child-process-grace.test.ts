/**
 * Adaptive post-exit stdio grace (utils/child-process.ts). After a child emits
 * `exit` but its stdout/stderr `end` has not arrived (a detached descendant may
 * still hold the pipe), waitForChildProcess waits a SHORT base window (25ms) and
 * only EXTENDS toward a 100ms cap while output is still actively arriving — so a
 * quiet command finalizes fast, while a trailing daemon flush is never clipped.
 * The base window is overridable via PIT_EXIT_STDIO_GRACE_MS.
 *
 * These use a lightweight EventEmitter stand-in for the child + fake timers so
 * the timing is fully deterministic (no real process/stream scheduling).
 */

import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForChildProcess } from "../src/utils/child-process.ts";

function makeStream(): EventEmitter & { destroy: () => void } {
	return Object.assign(new EventEmitter(), { destroy: () => {} });
}

function makeChild(): { child: ChildProcess; stdout: EventEmitter; stderr: EventEmitter } {
	const stdout = makeStream();
	const stderr = makeStream();
	const child = Object.assign(new EventEmitter(), { stdout, stderr });
	return { child: child as unknown as ChildProcess, stdout, stderr };
}

/** Attach a settlement tracker to a pending promise. */
function track<T>(p: Promise<T>): { settled: boolean; value: T | undefined } {
	const state: { settled: boolean; value: T | undefined } = { settled: false, value: undefined };
	p.then((v) => {
		state.settled = true;
		state.value = v;
	});
	return state;
}

describe("waitForChildProcess adaptive post-exit grace", () => {
	const PREV = process.env.PIT_EXIT_STDIO_GRACE_MS;

	beforeEach(() => {
		vi.useFakeTimers();
		delete process.env.PIT_EXIT_STDIO_GRACE_MS;
	});

	afterEach(() => {
		vi.useRealTimers();
		if (PREV === undefined) delete process.env.PIT_EXIT_STDIO_GRACE_MS;
		else process.env.PIT_EXIT_STDIO_GRACE_MS = PREV;
	});

	it("finalizes after the short base window when no trailing output arrives", async () => {
		const { child } = makeChild();
		const state = track(waitForChildProcess(child));

		child.emit("exit", 0);
		await vi.advanceTimersByTimeAsync(24);
		expect(state.settled).toBe(false); // still inside the 25ms base window

		await vi.advanceTimersByTimeAsync(2); // cross 25ms
		expect(state.settled).toBe(true);
		expect(state.value).toBe(0);
	});

	it("extends while output keeps arriving, then finalizes once it goes quiet (capped)", async () => {
		const { child, stdout } = makeChild();
		const state = track(waitForChildProcess(child));

		child.emit("exit", 0);
		// A trailing flush: a chunk every 20ms keeps resetting the base window, so
		// the grace must NOT finalize while data is still coming.
		for (let t = 20; t <= 80; t += 20) {
			await vi.advanceTimersByTimeAsync(20);
			stdout.emit("data", Buffer.from("x"));
		}
		expect(state.settled).toBe(false); // still flushing at t≈80ms

		// Output stops; the 100ms cap (from exit) is reached and it finalizes.
		await vi.advanceTimersByTimeAsync(25);
		expect(state.settled).toBe(true);
		expect(state.value).toBe(0);
	});

	it("respects PIT_EXIT_STDIO_GRACE_MS as the base window override", async () => {
		process.env.PIT_EXIT_STDIO_GRACE_MS = "10";
		const { child } = makeChild();
		const state = track(waitForChildProcess(child));

		child.emit("exit", 0);
		await vi.advanceTimersByTimeAsync(9);
		expect(state.settled).toBe(false); // shorter-than-default window still open

		await vi.advanceTimersByTimeAsync(2); // cross 10ms
		expect(state.settled).toBe(true);
		expect(state.value).toBe(0);
	});

	it("finalizes immediately on close regardless of the grace", async () => {
		const { child } = makeChild();
		const state = track(waitForChildProcess(child));

		child.emit("close", 0);
		await vi.advanceTimersByTimeAsync(0);
		expect(state.settled).toBe(true);
		expect(state.value).toBe(0);
	});
});
