/**
 * Pre-warmed spare-shell pool (bash.ts) — a spawn per bash call pays the
 * shell interpreter's full process-creation cost on every single tool call.
 * Pooling pre-spawns a disposable POSIX shell ahead of the call so that cost
 * moves off the critical path; each spare is used exactly once and never
 * shares state across calls.
 *
 * Pooling is opt-in (`enableSparePool: true`) — see createLocalBashOperations'
 * doc for why: a spare is a live process pinned to a cwd, and only a caller
 * with a bounded, reliably-disposed lifecycle should hold one open between
 * calls. These tests exercise that opt-in path directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_getBashSparePoolStatsForTest,
	_peekBashSparePoolForTest,
	_resetBashSparePoolForTest,
	createLocalBashOperations,
	disposeBashSparePool,
} from "../src/core/tools/bash.ts";
import { getShellConfig, killTrackedDetachedChildren } from "../src/utils/shell.ts";

function hasBash(): boolean {
	try {
		getShellConfig();
		return true;
	} catch {
		return false;
	}
}

const BASH_AVAILABLE = hasBash();

async function run(
	ops: ReturnType<typeof createLocalBashOperations>,
	command: string,
	cwd: string,
): Promise<{ exitCode: number | null; output: string }> {
	let output = "";
	const result = await ops.exec(command, cwd, {
		onData: (data) => {
			output += data.toString("utf-8");
		},
	});
	return { exitCode: result.exitCode, output };
}

/** Poll until `process.kill(pid, 0)` throws (POSIX + Windows both treat
 * signal 0 as an existence check — see killProcessTree's own comment in
 * shell.ts), or give up after `timeoutMs`. */
async function waitForPidExit(pid: number, timeoutMs = 4000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		if (Date.now() >= deadline) return false;
		await new Promise((r) => setTimeout(r, 50));
	}
}

describe.skipIf(!BASH_AVAILABLE)("bash spare-shell pool", () => {
	let cwdA: string;
	let cwdB: string;

	beforeEach(() => {
		_resetBashSparePoolForTest();
		cwdA = mkdtempSync(join(tmpdir(), "pit-bash-pool-a-"));
		cwdB = mkdtempSync(join(tmpdir(), "pit-bash-pool-b-"));
	});

	afterEach(() => {
		disposeBashSparePool();
		killTrackedDetachedChildren();
		_resetBashSparePoolForTest();
		for (const dir of [cwdA, cwdB]) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort cleanup
			}
		}
	});

	it("does not spawn or leave any spare when disabled (default)", async () => {
		const ops = createLocalBashOperations();
		const { exitCode, output } = await run(ops, "echo hello", cwdA);
		expect(exitCode).toBe(0);
		expect(output.trim()).toBe("hello");
		// No opt-in, no pooling: nothing left running between calls.
		expect(_peekBashSparePoolForTest()).toBeUndefined();
	});

	it("reuses the pre-warmed spare for the next call with a matching context", async () => {
		const ops = createLocalBashOperations({ enableSparePool: true });

		const first = await run(ops, "echo call1-out", cwdA);
		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe("call1-out");

		// The first call's own process was a direct spawn (no spare existed yet —
		// a miss) — it also kicked off a spare for next time.
		expect(_getBashSparePoolStatsForTest()).toEqual({ hits: 0, misses: 1 });
		const spareAfterFirst = _peekBashSparePoolForTest();
		expect(spareAfterFirst).toBeDefined();
		expect(spareAfterFirst?.dead).toBe(false);
		expect(spareAfterFirst?.cwd).toBe(cwdA);
		const sparePid = spareAfterFirst?.pid;

		const second = await run(ops, "echo call2-out", cwdA);
		expect(second.exitCode).toBe(0);
		expect(second.output.trim()).toBe("call2-out");

		// The second call was served by the pre-warmed spare — a hit. (bash's own
		// `$$` cannot be used to double-check this from the output: MSYS/Git-Bash
		// on Windows reports a virtual pid that does not match the Windows pid
		// Node sees, so the pool's own hit/miss counter is the ground truth here.)
		expect(_getBashSparePoolStatsForTest()).toEqual({ hits: 1, misses: 1 });

		// Consuming the spare immediately queues the NEXT one (still cwdA).
		const spareAfterSecond = _peekBashSparePoolForTest();
		expect(spareAfterSecond).toBeDefined();
		expect(spareAfterSecond?.pid).not.toBe(sparePid);
	});

	it("never leaks state between two single-use spares", async () => {
		const ops = createLocalBashOperations({ enableSparePool: true });
		// A variable set by the first command must not be visible to the second —
		// each spare is a fresh shell, not a persistent session.
		await run(ops, "leaked_var=oops", cwdA);
		const { output } = await run(ops, `echo "leaked=\${leaked_var:-clean}"`, cwdA);
		expect(output.trim()).toBe("leaked=clean");
	});

	it("discards a live spare when the next call's cwd differs, and never injects cd", async () => {
		const ops = createLocalBashOperations({ enableSparePool: true });

		await run(ops, "echo warm", cwdA);
		const spareForA = _peekBashSparePoolForTest();
		expect(spareForA).toBeDefined();
		expect(spareForA?.cwd).toBe(cwdA);
		const staleSparePid = spareForA?.pid as number;

		// A marker file that exists ONLY in cwdB: if the mismatched spare (whose
		// real OS cwd is cwdA) were reused as-is, or compensated for with an
		// injected `cd cwdB && ...`, a relative-path read would still behave
		// differently from a process whose OWN cwd is genuinely cwdB. Reading it
		// by relative path only succeeds when the command's process actually has
		// cwdB as its OS-level working directory.
		writeFileSync(join(cwdB, "marker.txt"), "B");
		const { exitCode, output } = await run(ops, "cat marker.txt", cwdB);
		expect(exitCode).toBe(0);
		expect(output.trim()).toBe("B");

		// The pool's own counter confirms the cwd change was seen as a miss (not
		// a hit that then got compensated for some other way).
		expect(_getBashSparePoolStatsForTest()).toEqual({ hits: 0, misses: 2 });

		// The slot now holds a NEW spare (for cwdB), not the stale cwdA one.
		const spareForB = _peekBashSparePoolForTest();
		expect(spareForB).toBeDefined();
		expect(spareForB?.cwd).toBe(cwdB);
		expect(spareForB?.pid).not.toBe(staleSparePid);

		// The discarded spare was actually killed, not merely forgotten.
		expect(await waitForPidExit(staleSparePid)).toBe(true);
	});

	it("kills a pending spare on dispose so it can never leak a process", async () => {
		const ops = createLocalBashOperations({ enableSparePool: true });
		await run(ops, "echo warm", cwdA);
		const spare = _peekBashSparePoolForTest();
		expect(spare).toBeDefined();
		const pid = spare?.pid as number;

		disposeBashSparePool();

		expect(_peekBashSparePoolForTest()).toBeUndefined();
		expect(await waitForPidExit(pid)).toBe(true);
	});
});
