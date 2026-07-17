/**
 * Escalation-timer regression for execCommand: a child that ignores SIGTERM
 * must be force-killed via killProcessTree once the grace period elapses.
 *
 * Windows maps proc.kill("SIGTERM") to TerminateProcess, so a real child cannot
 * ignore SIGTERM; the escalation branch is exercised here with a fake clock and
 * a stubbed spawn whose exit is deferred (so `settled` stays false across the
 * grace period). This proves the gate is `!settled`, not `!proc.killed` — the
 * latter is true the instant the signal is SENT and could never fire the branch.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
	killProcessTree: vi.fn(),
	proc: null as unknown as EventEmitter & { pid?: number; kill: (sig: string) => boolean },
	// Resolvers for the pending waitForChildProcess promise; calling one settles
	// execCommand exactly like a genuine child exit.
	exitResolvers: [] as Array<(code: number | null) => void>,
}));

vi.mock("../src/utils/shell.js", () => ({
	killProcessTree: (pid: number) => mockState.killProcessTree(pid),
}));

vi.mock("../src/utils/child-process.js", () => ({
	spawnProcess: () => mockState.proc,
	waitForChildProcess: () =>
		new Promise<number | null>((resolve) => {
			mockState.exitResolvers.push(resolve);
		}),
}));

const { execCommand } = await import("../src/core/exec.js");

function makeFakeProc(pid = 4242) {
	const proc = new EventEmitter() as EventEmitter & {
		pid?: number;
		kill: (sig: string) => boolean;
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	proc.pid = pid;
	proc.kill = vi.fn(() => true) as unknown as (sig: string) => boolean;
	proc.stdout = new EventEmitter();
	proc.stderr = new EventEmitter();
	return proc;
}

beforeEach(() => {
	mockState.killProcessTree.mockClear();
	mockState.exitResolvers = [];
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("execCommand SIGKILL escalation", () => {
	it("escalates to killProcessTree when the child ignores SIGTERM (settled=false after grace)", async () => {
		const proc = makeFakeProc(4242);
		mockState.proc = proc;
		const controller = new AbortController();
		const resultPromise = execCommand("sleep", ["100"], process.cwd(), { signal: controller.signal });

		// Abort → killProcess sends SIGTERM and arms the 5s escalation timer.
		controller.abort();
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

		// The child never settles; advancing past SIGKILL_GRACE_MS (5s) must fire
		// the escalation because the gate is `!settled`.
		await vi.advanceTimersByTimeAsync(5000);
		expect(mockState.killProcessTree).toHaveBeenCalledWith(4242);

		// Let the child finally exit so execCommand settles and resolves cleanly.
		for (const resolve of mockState.exitResolvers) resolve(0);
		await vi.advanceTimersByTimeAsync(0);
		const result = await resultPromise;
		expect(result.killed).toBe(true);
	});

	it("does not escalate when the child exits within the grace period", async () => {
		const proc = makeFakeProc(4243);
		mockState.proc = proc;
		const controller = new AbortController();
		const resultPromise = execCommand("sleep", ["100"], process.cwd(), { signal: controller.signal });

		controller.abort();
		expect(proc.kill).toHaveBeenCalledWith("SIGTERM");

		// Child exits before the grace period → settle() clears the escalation timer.
		for (const resolve of mockState.exitResolvers) resolve(0);
		await vi.advanceTimersByTimeAsync(0);
		await resultPromise;

		await vi.advanceTimersByTimeAsync(5000);
		expect(mockState.killProcessTree).not.toHaveBeenCalled();
	});
});
