/**
 * Escalation-timer regression for the hook runner: a hook that ignores SIGTERM
 * on timeout must be reaped via killProcessTree once the 2s escalation elapses.
 *
 * Windows maps proc.kill("SIGTERM") to TerminateProcess, so a real child cannot
 * ignore SIGTERM; the escalation branch is exercised here with a fake clock and
 * a stubbed spawn whose child never emits 'close' (so `exited` stays false). This
 * proves the gate is `!exited`, not `!proc.killed` (true the instant the signal
 * is SENT, so it could never let the branch fire). Kept in its own file so the
 * node:child_process mock does not affect the real-spawn tests in hooks-runner.
 */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreToolUsePayload } from "../src/core/hooks/types.js";

const mockState = vi.hoisted(() => ({
	killProcessTree: vi.fn(),
	child: null as unknown as EventEmitter & { pid?: number; kill: (sig: string) => boolean },
}));

vi.mock("../src/utils/shell.js", () => ({
	killProcessTree: (pid: number) => mockState.killProcessTree(pid),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: () => mockState.child };
});

const { runHook } = await import("../src/core/hooks/runner.js");

const payload: PreToolUsePayload = {
	event: "PreToolUse",
	toolName: "bash",
	toolCallId: "t1",
	input: { command: "ls" },
	cwd: process.cwd(),
};

function makeFakeChild(pid = 9191) {
	const child = new EventEmitter() as EventEmitter & {
		pid?: number;
		kill: (sig: string) => boolean;
		stdin: { write: () => void; end: () => void; on: () => void };
		stdout: EventEmitter;
		stderr: EventEmitter;
	};
	child.pid = pid;
	child.kill = vi.fn(() => true) as unknown as (sig: string) => boolean;
	child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() };
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	return child;
}

beforeEach(() => {
	mockState.killProcessTree.mockClear();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("runHook SIGKILL escalation", () => {
	it("escalates a timed-out hook to killProcessTree when it never exits (exited=false)", async () => {
		const child = makeFakeChild(9191);
		mockState.child = child;
		const promise = runHook({ command: "sleep 100", timeoutMs: 50 }, payload, { cwd: process.cwd() });

		// Timeout fires → kill() sends SIGTERM and arms the 2s escalation timer.
		await vi.advanceTimersByTimeAsync(50);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		const result = await promise;
		expect(result.timedOut).toBe(true);

		// The child never emitted 'close', so `exited` stays false → escalation fires.
		await vi.advanceTimersByTimeAsync(2000);
		expect(mockState.killProcessTree).toHaveBeenCalledWith(9191);
	});

	it("does not escalate when the hook exits (close handler sets exited)", async () => {
		const child = makeFakeChild(9192);
		mockState.child = child;
		const promise = runHook({ command: "sleep 100", timeoutMs: 50 }, payload, { cwd: process.cwd() });

		// Timeout arms the escalation timer.
		await vi.advanceTimersByTimeAsync(50);
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");

		// Genuine exit: the 'close' handler sets `exited` and clears the escalation.
		child.emit("close", 0);
		await promise;

		await vi.advanceTimersByTimeAsync(2000);
		expect(mockState.killProcessTree).not.toHaveBeenCalled();
	});
});
