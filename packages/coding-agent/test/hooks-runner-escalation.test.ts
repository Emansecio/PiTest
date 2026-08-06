/** Awaitable process-tree cleanup regressions for timeout, abort and output cap. */

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreToolUsePayload } from "../src/core/hooks/types.js";

const mockState = vi.hoisted(() => ({
	killProcessTreeAndWait: vi.fn((_pid: number) => Promise.resolve(true)),
	child: null as unknown as EventEmitter & { pid?: number; kill: (sig: string) => boolean },
	spawnCalls: [] as unknown[][],
}));

vi.mock("../src/utils/shell.js", () => ({
	killProcessTreeAndWait: (pid: number) => mockState.killProcessTreeAndWait(pid),
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (...args: unknown[]) => {
			mockState.spawnCalls.push(args);
			return mockState.child;
		},
	};
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
	mockState.killProcessTreeAndWait.mockClear();
	mockState.killProcessTreeAndWait.mockImplementation((_pid: number) => Promise.resolve(true));
	mockState.spawnCalls.length = 0;
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("runHook process-tree cleanup", () => {
	function deferredCleanup() {
		let resolve!: (value: boolean) => void;
		const promise = new Promise<boolean>((done) => {
			resolve = done;
		});
		mockState.killProcessTreeAndWait.mockImplementation(() => promise);
		return { resolve };
	}

	async function expectPending(promise: Promise<unknown>): Promise<void> {
		let settled = false;
		void promise.finally(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);
	}

	it("does not resolve a timeout before process-tree cleanup completes", async () => {
		const cleanup = deferredCleanup();
		const child = makeFakeChild(9191);
		mockState.child = child;
		const promise = runHook({ command: "sleep 100", timeoutMs: 50 }, payload, { cwd: process.cwd() });

		await vi.advanceTimersByTimeAsync(50);
		expect(mockState.killProcessTreeAndWait).toHaveBeenCalledWith(9191);
		await expectPending(promise);
		child.emit("close", 0);
		await expectPending(promise);

		cleanup.resolve(true);
		const result = await promise;
		expect(result.timedOut).toBe(true);
		expect(mockState.killProcessTreeAndWait).toHaveBeenCalledTimes(1);
	});

	it("does not resolve an abort before process-tree cleanup completes", async () => {
		const cleanup = deferredCleanup();
		const controller = new AbortController();
		mockState.child = makeFakeChild(9192);
		const promise = runHook({ command: "sleep 100", timeoutMs: 5_000 }, payload, {
			cwd: process.cwd(),
			signal: controller.signal,
		});

		controller.abort();
		await Promise.resolve();
		expect(mockState.killProcessTreeAndWait).toHaveBeenCalledWith(9192);
		await expectPending(promise);

		cleanup.resolve(true);
		const result = await promise;
		expect(result.timedOut).toBe(false);
		expect(mockState.killProcessTreeAndWait).toHaveBeenCalledTimes(1);
	});

	it("cleans up safely when the signal was already aborted before spawn", async () => {
		const controller = new AbortController();
		controller.abort();
		mockState.child = makeFakeChild(9196);

		await expect(
			runHook({ command: "sleep 100", timeoutMs: 5_000 }, payload, {
				cwd: process.cwd(),
				signal: controller.signal,
			}),
		).resolves.toMatchObject({ exitCode: -1, timedOut: false, rawError: "aborted" });
		expect(mockState.killProcessTreeAndWait).toHaveBeenCalledWith(9196);
	});

	it("does not resolve an output-cap termination before cleanup completes", async () => {
		const cleanup = deferredCleanup();
		const child = makeFakeChild(9193);
		mockState.child = child;
		const promise = runHook({ command: "noisy", timeoutMs: 5_000 }, payload, { cwd: process.cwd() });

		child.stdout.emit("data", Buffer.alloc(4 * 1024 * 1024 + 1));
		await Promise.resolve();
		expect(mockState.killProcessTreeAndWait).toHaveBeenCalledWith(9193);
		await expectPending(promise);

		cleanup.resolve(true);
		const result = await promise;
		expect(result.exitCode).toBe(-1);
		expect(mockState.killProcessTreeAndWait).toHaveBeenCalledTimes(1);
	});

	it("surfaces incomplete cleanup instead of silently hiding it", async () => {
		mockState.killProcessTreeAndWait.mockResolvedValue(false);
		mockState.child = makeFakeChild(9194);
		const promise = runHook({ command: "sleep 100", timeoutMs: 50 }, payload, { cwd: process.cwd() });

		await vi.advanceTimersByTimeAsync(50);
		const result = await promise;
		expect(result.rawError).toBe("process tree cleanup did not complete");
	});

	it("parses quoted direct-hook arguments and creates a POSIX process group", async () => {
		mockState.child = makeFakeChild(9195);
		const promise = runHook({ command: 'node "script with spaces.js"', shell: false }, payload, {
			cwd: process.cwd(),
		});
		mockState.child.emit("close", 0);
		await promise;

		expect(mockState.spawnCalls[0]?.[0]).toBe("node");
		expect(mockState.spawnCalls[0]?.[1]).toEqual(["script with spaces.js"]);
		expect(mockState.spawnCalls[0]?.[2]).toMatchObject({ detached: process.platform !== "win32", shell: false });
	});
});
