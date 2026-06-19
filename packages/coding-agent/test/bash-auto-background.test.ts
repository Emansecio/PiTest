/**
 * Auto-backgrounding — a synchronous bash command WITHOUT an explicit hard
 * timeout that outruns the auto-background threshold is PROMOTED to a tracked
 * background job instead of being killed. The model gets a handle + the output
 * captured up to promotion, the detached process keeps running, and it is reaped
 * on shutdown via the existing `killTrackedDetachedChildren` (by pid) so nothing
 * leaks.
 *
 * Anti-flaky: the threshold is injected MINUSCULE (0.15s) via the
 * PIT_BASH_AUTO_BACKGROUND_SECONDS env flag. The watched command sleeps for 5s,
 * so the ONLY way `exec` settles in time is the promotion path firing — the test
 * cannot pass by the command finishing on its own. The 150ms timer is the
 * promotion mechanism, not a wait. Guarded by a bash-availability check so a
 * machine without Git Bash skips rather than flakes. Every promoted process is
 * force-killed in afterEach regardless of assertions, so the suite never leaks.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetBashBackgroundJobsForTest,
	createBashToolDefinition,
	createLocalBashOperations,
	getBashBackgroundJob,
	killBashBackgroundJob,
	listBashBackgroundJobs,
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

describe("bash auto-background: promote on threshold instead of kill", () => {
	const PREV = process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS;

	beforeEach(() => {
		_resetBashBackgroundJobsForTest();
		// 150ms threshold: a `sleep 5` will cross it and be promoted, fast.
		process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS = "0.15";
	});

	afterEach(() => {
		// Reap any process the test promoted, by pid, exactly like shutdown does.
		killTrackedDetachedChildren();
		for (const job of listBashBackgroundJobs()) job.kill();
		_resetBashBackgroundJobsForTest();
		if (PREV === undefined) delete process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS;
		else process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS = PREV;
	});

	it.skipIf(!BASH_AVAILABLE)(
		"promotes a long command (no timeout) to a tracked background job, returning a handle + partial output",
		async () => {
			// De-flake: under the full parallel suite the child SPAWN alone can exceed the
			// 0.15s promotion threshold, so `echo started` may not land before promotion and
			// `partial` comes back empty. Give spawn+echo a comfortable window — still far
			// below the 5s sleep, so promotion (not completion) is what settles it, and well
			// under the 3s settle assertion below.
			process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS = "1";
			const ops = createLocalBashOperations();
			const start = Date.now();
			let partial = "";

			// `echo started; sleep 5`: the echo lands before the 150ms promotion, so
			// the caller sees partial output; the sleep would block 5s but promotion
			// fires first. No explicit timeout => eligible for auto-background.
			const result = await ops.exec("echo started; sleep 5", process.cwd(), {
				autoBackground: true,
				onData: (d) => {
					partial += d.toString("utf-8");
				},
			});

			// Settled fast via promotion, NOT by the command finishing (5s) or a kill.
			expect(Date.now() - start).toBeLessThan(3_000);
			// The promotion contract: exitCode null + a job id handle.
			expect(result.exitCode).toBeNull();
			expect(result.promotedJobId).toBeTruthy();
			// Output collected up to promotion is surfaced to the caller.
			expect(partial).toContain("started");

			// The job is tracked and pollable by its handle.
			const id = result.promotedJobId as string;
			const job = getBashBackgroundJob(id);
			expect(job).toBeDefined();
			expect(job?.exited).toBe(false);
			expect(typeof job?.pid).toBe("number");
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"shutdown cleanup kills the promoted process (no leak) and killBashBackgroundJob drops the handle",
		async () => {
			const ops = createLocalBashOperations();
			const { promotedJobId } = await ops.exec("sleep 5", process.cwd(), {
				autoBackground: true,
				onData: () => undefined,
			});
			const id = promotedJobId as string;
			expect(getBashBackgroundJob(id)).toBeDefined();

			// Shutdown path: reap every tracked detached child by pid. The promoted
			// process is still tracked (promotion does not untrack), so it dies here.
			killTrackedDetachedChildren();

			// Explicit kill of the job handle drops it from the registry.
			expect(killBashBackgroundJob(id)).toBe(true);
			expect(getBashBackgroundJob(id)).toBeUndefined();
			expect(killBashBackgroundJob(id)).toBe(false);
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"a fast command under the threshold completes normally and is NOT promoted",
		async () => {
			// Generous threshold so a sub-second `echo` is reliably "under" it even
			// when the full suite runs in parallel and slows the spawn — the 0.15s
			// beforeEach value is for the promotion cases and would flake-promote here.
			process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS = "60";
			const ops = createLocalBashOperations();
			const { exitCode, promotedJobId } = await ops.exec("echo hi", process.cwd(), {
				autoBackground: true,
				onData: () => undefined,
			});
			expect(exitCode).toBe(0);
			expect(promotedJobId).toBeUndefined();
			expect(listBashBackgroundJobs()).toHaveLength(0);
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"an explicit hard timeout is honored as a KILL (idle-real death), never promoted",
		async () => {
			// Threshold (150ms) < timeout (300ms): even though the auto-bg window is
			// smaller, an explicit timeout means the model wants a kill, so promotion
			// is suppressed and the command is reaped with a timeout error.
			const ops = createLocalBashOperations();
			await expect(
				ops.exec("sleep 5", process.cwd(), { autoBackground: true, timeout: 0.3, onData: () => undefined }),
			).rejects.toThrow(/timeout/i);
			// Nothing was promoted — the kill path won even with opt-in, because an
			// explicit timeout outranks auto-background.
			expect(listBashBackgroundJobs()).toHaveLength(0);
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"end-to-end through the bash tool: execute returns the 'promoted to background id=' message + partial output, no throw",
		async () => {
			// De-flake (same race as the first promotion test): widen the window so the
			// `echo marker-line` reliably lands before promotion under full-suite load.
			// Still ≪ the 5s sleep, so promotion is what settles it.
			process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS = "1";
			const def = createBashToolDefinition(process.cwd());
			const ctx = {} as Parameters<typeof def.execute>[4];
			// No timeout arg => eligible. echo lands before promotion, sleep blocks.
			const result = (await def.execute(
				"call-bg",
				{ command: "echo marker-line; sleep 5" },
				undefined,
				undefined,
				ctx,
			)) as { content: Array<{ type: string; text?: string }> };

			const text = result.content[0]?.text ?? "";
			// Promotion is reported, not thrown — the model can poll/kill via the id.
			expect(text).toMatch(/promoted to background id=/i);
			// The output captured up to promotion is included.
			expect(text).toContain("marker-line");

			// Exactly one job was promoted and is tracked.
			expect(listBashBackgroundJobs()).toHaveLength(1);
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"the tool message reports the REAL elapsed time to promotion, not a recomputed threshold",
		async () => {
			const def = createBashToolDefinition(process.cwd());
			const ctx = {} as Parameters<typeof def.execute>[4];
			const result = (await def.execute("call-elapsed", { command: "sleep 5" }, undefined, undefined, ctx)) as {
				content: Array<{ type: string; text?: string }>;
			};

			const text = result.content[0]?.text ?? "";
			const match = /after ([\d.]+)s/.exec(text);
			expect(match).not.toBeNull();
			const reported = Number(match?.[1]);
			// The job's real promotedAt−startedAt is what's reported. With a 150ms
			// threshold it is ≥ 0.15s (timer fires at/after the threshold + drift) and
			// comfortably under a second — i.e. a measured elapsed, not a hardcoded 60.
			const job = listBashBackgroundJobs()[0];
			expect(job).toBeDefined();
			const realElapsed = (job.promotedAt - job.startedAt) / 1000;
			expect(reported).toBeCloseTo(realElapsed, 1);
			expect(reported).toBeGreaterThanOrEqual(0.1);
			expect(reported).toBeLessThan(3);
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"explicit backgroundImmediate detaches a long command after the startup window, returning a handle",
		async () => {
			// Small startup window: `sleep 5` is still running after it, so it promotes
			// fast — completion (5s) cannot be what settles this.
			process.env.PIT_BASH_BACKGROUND_STARTUP_MS = "150";
			const ops = createLocalBashOperations();
			const start = Date.now();
			const { exitCode, promotedJobId } = await ops.exec("sleep 5", process.cwd(), {
				autoBackground: true,
				backgroundImmediate: true,
				onData: () => undefined,
			});
			expect(Date.now() - start).toBeLessThan(3_000);
			expect(exitCode).toBeNull();
			expect(promotedJobId).toBeTruthy();
			expect(getBashBackgroundJob(promotedJobId as string)?.exited).toBe(false);
			delete process.env.PIT_BASH_BACKGROUND_STARTUP_MS;
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"a background command that finishes within the startup window returns normally (not promoted)",
		async () => {
			// Generous startup window so the sub-second `echo` completes inside it and
			// resolves with a real exit code instead of detaching.
			process.env.PIT_BASH_BACKGROUND_STARTUP_MS = "5000";
			const ops = createLocalBashOperations();
			const { exitCode, promotedJobId } = await ops.exec("echo hi", process.cwd(), {
				autoBackground: true,
				backgroundImmediate: true,
				onData: () => undefined,
			});
			expect(exitCode).toBe(0);
			expect(promotedJobId).toBeUndefined();
			expect(listBashBackgroundJobs()).toHaveLength(0);
			delete process.env.PIT_BASH_BACKGROUND_STARTUP_MS;
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"end-to-end: bash tool with background:true returns the 'promoted to background id=' message without throwing",
		async () => {
			process.env.PIT_BASH_BACKGROUND_STARTUP_MS = "150";
			const def = createBashToolDefinition(process.cwd());
			const ctx = {} as Parameters<typeof def.execute>[4];
			const result = (await def.execute(
				"call-bg-explicit",
				{ command: "sleep 5", background: true },
				undefined,
				undefined,
				ctx,
			)) as { content: Array<{ type: string; text?: string }> };
			const text = result.content[0]?.text ?? "";
			expect(text).toMatch(/promoted to background id=/i);
			expect(listBashBackgroundJobs()).toHaveLength(1);
			delete process.env.PIT_BASH_BACKGROUND_STARTUP_MS;
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"WITHOUT autoBackground opt-in (the user `!` path), a long command is NOT silently detached — it runs to completion",
		async () => {
			// Regression guard: the user `!` path goes through executeBashWithOperations,
			// which reads only `exitCode` and never `promotedJobId`. If exec promoted by
			// default, that command would silently detach with no reachable handle. With
			// opt-in OFF, a command that outruns the 150ms threshold must instead run to
			// completion and return a real exit code — never promoted, registry empty.
			const ops = createLocalBashOperations();
			const start = Date.now();
			const { exitCode, promotedJobId } = await ops.exec("sleep 0.5; echo done", process.cwd(), {
				onData: () => undefined,
			});
			// It actually waited for the command (≥ ~0.5s), i.e. it did not return early
			// via a promotion at the 150ms threshold.
			expect(Date.now() - start).toBeGreaterThanOrEqual(400);
			expect(exitCode).toBe(0);
			expect(promotedJobId).toBeUndefined();
			expect(listBashBackgroundJobs()).toHaveLength(0);
		},
		15_000,
	);
});
