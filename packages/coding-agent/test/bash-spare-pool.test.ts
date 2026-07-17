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
	_setBashSpareIdleTtlForTest,
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

/** Find the pooled spare for a given cwd (contexts are keyed by cwd here since
 * shell/args/env are constant across these ops). */
function poolEntryForCwd(cwd: string): { pid: number | undefined; cwd: string; dead: boolean } | undefined {
	return _peekBashSparePoolForTest().find((s) => s.cwd === cwd);
}

/** Refill is asynchronous (it happens off the call's critical path — that's the
 * point of the pool), so under a loaded full-suite run the entry may not exist
 * the instant `run()` returns. Poll briefly instead of asserting immediately. */
async function waitForPoolEntry(
	cwd: string,
	timeoutMs = 4000,
): Promise<{ pid: number | undefined; cwd: string; dead: boolean } | undefined> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const entry = poolEntryForCwd(cwd);
		if (entry?.pid !== undefined) return entry;
		if (Date.now() >= deadline) return entry;
		await new Promise((r) => setTimeout(r, 10));
	}
}

describe.skipIf(!BASH_AVAILABLE)("bash spare-shell pool", () => {
	let cwdA: string;
	let cwdB: string;
	let cwdC: string;
	const PREV_POOL = process.env.PIT_BASH_SPARE_POOL;

	beforeEach(() => {
		_resetBashSparePoolForTest();
		_setBashSpareIdleTtlForTest(undefined);
		delete process.env.PIT_BASH_SPARE_POOL;
		cwdA = mkdtempSync(join(tmpdir(), "pit-bash-pool-a-"));
		cwdB = mkdtempSync(join(tmpdir(), "pit-bash-pool-b-"));
		cwdC = mkdtempSync(join(tmpdir(), "pit-bash-pool-c-"));
	});

	afterEach(() => {
		disposeBashSparePool();
		killTrackedDetachedChildren();
		_resetBashSparePoolForTest();
		_setBashSpareIdleTtlForTest(undefined);
		if (PREV_POOL === undefined) delete process.env.PIT_BASH_SPARE_POOL;
		else process.env.PIT_BASH_SPARE_POOL = PREV_POOL;
		for (const dir of [cwdA, cwdB, cwdC]) {
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
		expect(_peekBashSparePoolForTest()).toHaveLength(0);
	});

	it("reuses the pre-warmed spare for the next call with a matching context", async () => {
		const ops = createLocalBashOperations({ enableSparePool: true });

		const first = await run(ops, "echo call1-out", cwdA);
		expect(first.exitCode).toBe(0);
		expect(first.output.trim()).toBe("call1-out");

		// The first call's own process was a direct spawn (no spare existed yet —
		// a miss) — it also kicked off a spare for next time.
		expect(_getBashSparePoolStatsForTest()).toEqual({ hits: 0, misses: 1 });
		const spareAfterFirst = poolEntryForCwd(cwdA);
		expect(spareAfterFirst).toBeDefined();
		expect(spareAfterFirst?.dead).toBe(false);
		const sparePid = spareAfterFirst?.pid;

		const second = await run(ops, "echo call2-out", cwdA);
		expect(second.exitCode).toBe(0);
		expect(second.output.trim()).toBe("call2-out");

		// The second call was served by the pre-warmed spare — a hit. (bash's own
		// `$$` cannot be used to double-check this from the output: MSYS/Git-Bash
		// on Windows reports a virtual pid that does not match the Windows pid
		// Node sees, so the pool's own hit/miss counter is the ground truth here.)
		expect(_getBashSparePoolStatsForTest()).toEqual({ hits: 1, misses: 1 });

		// Consuming the spare immediately refills the SAME context with a new one.
		const spareAfterSecond = poolEntryForCwd(cwdA);
		expect(spareAfterSecond).toBeDefined();
		expect(spareAfterSecond?.pid).not.toBe(sparePid);
	});

	it("serves back-to-back same-context calls entirely from the pool (refill hits)", async () => {
		const ops = createLocalBashOperations({ enableSparePool: true });
		// First call is the only miss (cold pool); every call after it hits the
		// spare refilled by the previous call.
		for (let i = 0; i < 4; i++) {
			const { exitCode, output } = await run(ops, `echo iter-${i}`, cwdA);
			expect(exitCode).toBe(0);
			expect(output.trim()).toBe(`iter-${i}`);
		}
		expect(_getBashSparePoolStatsForTest()).toEqual({ hits: 3, misses: 1 });
	});

	it("never leaks state between two single-use spares", async () => {
		const ops = createLocalBashOperations({ enableSparePool: true });
		// A variable set by the first command must not be visible to the second —
		// each spare is a fresh shell, not a persistent session.
		await run(ops, "leaked_var=oops", cwdA);
		const { output } = await run(ops, `echo "leaked=\${leaked_var:-clean}"`, cwdA);
		expect(output.trim()).toBe("leaked=clean");
	});

	it("keeps a spare per context so alternating cwds both hit, never injecting cd", async () => {
		// Default pool size (2) has room for both contexts.
		const ops = createLocalBashOperations({ enableSparePool: true });

		await run(ops, "echo warm", cwdA); // miss (cold), warms A
		const spareForA = poolEntryForCwd(cwdA);
		expect(spareForA).toBeDefined();
		const aPid = spareForA?.pid as number;

		// A marker file that exists ONLY in cwdB: if a cwdA spare were reused as-is,
		// or compensated for with an injected `cd cwdB && ...`, a relative-path read
		// would behave differently from a process whose OWN cwd is genuinely cwdB.
		writeFileSync(join(cwdB, "marker.txt"), "B");
		const firstB = await run(ops, "cat marker.txt", cwdB); // miss (no B spare yet)
		expect(firstB.exitCode).toBe(0);
		expect(firstB.output.trim()).toBe("B");

		// Both contexts are now warm; the cwdA spare was NOT killed by the cwdB call.
		expect(poolEntryForCwd(cwdA)).toBeDefined();
		expect(poolEntryForCwd(cwdB)).toBeDefined();
		expect(poolEntryForCwd(cwdA)?.pid).toBe(aPid);
		expect(await waitForPidExit(aPid, 300)).toBe(false); // still alive

		// Alternating back to each context now hits the retained spares.
		await run(ops, "echo a2", cwdA); // hit A
		await run(ops, "echo b2", cwdB); // hit B
		expect(_getBashSparePoolStatsForTest()).toEqual({ hits: 2, misses: 2 });
	});

	it("LRU-evicts (and kills) the oldest spare when the pool is over size", async () => {
		process.env.PIT_BASH_SPARE_POOL = "1"; // only one context stays warm
		const ops = createLocalBashOperations({ enableSparePool: true });

		await run(ops, "echo warm", cwdA);
		const aPid = poolEntryForCwd(cwdA)?.pid as number;
		expect(aPid).toBeGreaterThan(0);

		// A call in cwdB warms B and pushes the pool over size 1 → the older A spare
		// is evicted and its process killed.
		await run(ops, "echo warm", cwdB);
		expect(poolEntryForCwd(cwdB)).toBeDefined();
		expect(poolEntryForCwd(cwdA)).toBeUndefined();
		expect(_peekBashSparePoolForTest()).toHaveLength(1);
		expect(await waitForPidExit(aPid)).toBe(true);
	});

	it("disables pooling when PIT_BASH_SPARE_POOL=0 (no spare left warm)", async () => {
		process.env.PIT_BASH_SPARE_POOL = "0";
		const ops = createLocalBashOperations({ enableSparePool: true });

		const { exitCode, output } = await run(ops, "echo hi", cwdA);
		expect(exitCode).toBe(0);
		expect(output.trim()).toBe("hi");
		// Size 0 = disabled: no refill, so nothing is left running between calls.
		expect(_peekBashSparePoolForTest()).toHaveLength(0);

		const second = await run(ops, "echo hi2", cwdA);
		expect(second.output.trim()).toBe("hi2");
		expect(_peekBashSparePoolForTest()).toHaveLength(0);
		// Both calls fell back to a direct spawn.
		expect(_getBashSparePoolStatsForTest()).toEqual({ hits: 0, misses: 2 });
	});

	it("idle-TTL evicts and kills a spare that is never consumed", async () => {
		// Short idle window, but wide enough that a loaded full-suite run can't
		// burn the whole TTL between the refill (mid-run) and our first peek —
		// the original 80ms did exactly that and flaked.
		_setBashSpareIdleTtlForTest(500);
		const ops = createLocalBashOperations({ enableSparePool: true });

		await run(ops, "echo warm", cwdA);
		const pid = (await waitForPoolEntry(cwdA))?.pid as number;
		expect(pid).toBeGreaterThan(0);

		// Leave it idle past the TTL — it should self-evict and be killed, releasing
		// any open handle on its cwd.
		expect(await waitForPidExit(pid, 2000)).toBe(true);
		expect(poolEntryForCwd(cwdA)).toBeUndefined();
	});

	it("kills all pooled spares on dispose so none can leak a process", async () => {
		process.env.PIT_BASH_SPARE_POOL = "2";
		const ops = createLocalBashOperations({ enableSparePool: true });
		await run(ops, "echo warm", cwdA);
		await run(ops, "echo warm", cwdB);
		await waitForPoolEntry(cwdA);
		await waitForPoolEntry(cwdB);
		const pids = _peekBashSparePoolForTest().map((s) => s.pid as number);
		expect(pids.length).toBeGreaterThanOrEqual(1);

		disposeBashSparePool();

		expect(_peekBashSparePoolForTest()).toHaveLength(0);
		for (const pid of pids) {
			expect(await waitForPidExit(pid)).toBe(true);
		}
	});
});
