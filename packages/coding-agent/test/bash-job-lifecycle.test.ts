/**
 * Background-job lifecycle surface added with the /jobs panel:
 * - stall detection (isBashBackgroundJobStalled): output-idle window, with
 *   watcher/server commands exempt and PIT_BASH_STALL_SECONDS as the knob;
 * - lifecycle events (onBashBackgroundJobEvent): killed carries its source so a
 *   UI kill can be surfaced to the agent while tool/shutdown kills stay silent;
 * - action:"wait": one bounded blocking call instead of a poll loop;
 * - poll format: last-output age + a kill hint once a job looks hung.
 *
 * Everything here runs against synthetic registry entries — no shell spawns, so
 * the suite is hermetic and fast.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	type BashBackgroundJob,
	type BashBackgroundJobEvent,
	createBashToolDefinition,
	getBashBackgroundJob,
	isBashBackgroundJobStalled,
	killBashBackgroundJob,
	onBashBackgroundJobEvent,
} from "../src/core/tools/bash.ts";
import { isWatchOrServerCommand } from "../src/core/verification/pending-checks.ts";

const PREV_STALL = process.env.PIT_BASH_STALL_SECONDS;

function seedJob(overrides: Partial<BashBackgroundJob> & { id: string }): BashBackgroundJob {
	const now = Date.now();
	const job: BashBackgroundJob = {
		pid: undefined,
		command: "npm run build",
		startedAt: now - 2_000,
		promotedAt: now - 1_000,
		exited: false,
		exitCode: null,
		lastOutputAt: now - 1_000,
		resultSeen: false,
		ringBuffer: "",
		ringTruncated: false,
		kill: () => {},
		...overrides,
	};
	_registerBashBackgroundJobForTest(job);
	return job;
}

beforeEach(() => {
	_resetBashBackgroundJobsForTest();
});

afterEach(() => {
	_resetBashBackgroundJobsForTest();
	if (PREV_STALL === undefined) delete process.env.PIT_BASH_STALL_SECONDS;
	else process.env.PIT_BASH_STALL_SECONDS = PREV_STALL;
});

describe("isBashBackgroundJobStalled", () => {
	it("flags a non-watcher job quiet past the window; fresh output un-flags it", () => {
		process.env.PIT_BASH_STALL_SECONDS = "10";
		const job = seedJob({ id: "bg-1", lastOutputAt: Date.now() - 60_000, promotedAt: Date.now() - 60_000 });
		expect(isBashBackgroundJobStalled(job)).toBe(true);
		job.lastOutputAt = Date.now();
		expect(isBashBackgroundJobStalled(job)).toBe(false);
	});

	it("never flags watchers/servers (expected-quiet) or exited jobs", () => {
		process.env.PIT_BASH_STALL_SECONDS = "10";
		const quietAges = { lastOutputAt: Date.now() - 60_000, promotedAt: Date.now() - 60_000 };
		expect(isBashBackgroundJobStalled(seedJob({ id: "bg-1", command: "npm run dev", ...quietAges }))).toBe(false);
		expect(isBashBackgroundJobStalled(seedJob({ id: "bg-2", exited: true, exitCode: 0, ...quietAges }))).toBe(false);
	});

	it("PIT_BASH_STALL_SECONDS=0 disables detection entirely", () => {
		process.env.PIT_BASH_STALL_SECONDS = "0";
		const job = seedJob({ id: "bg-1", lastOutputAt: Date.now() - 3_600_000, promotedAt: Date.now() - 3_600_000 });
		expect(isBashBackgroundJobStalled(job)).toBe(false);
	});
});

describe("isWatchOrServerCommand", () => {
	it("matches watchers/servers and not one-shot commands", () => {
		expect(isWatchOrServerCommand("npm run dev")).toBe(true);
		expect(isWatchOrServerCommand("vitest --watch")).toBe(true);
		expect(isWatchOrServerCommand("npm run build")).toBe(false);
		expect(isWatchOrServerCommand("grep -r foo .")).toBe(false);
	});
});

describe("onBashBackgroundJobEvent", () => {
	it("kill emits `killed` with its source; unsubscribe stops delivery", () => {
		const events: BashBackgroundJobEvent[] = [];
		const unsubscribe = onBashBackgroundJobEvent((event) => events.push(event));
		try {
			seedJob({ id: "bg-1" });
			seedJob({ id: "bg-2" });
			killBashBackgroundJob("bg-1", "ui");
			killBashBackgroundJob("bg-2");
			expect(events).toHaveLength(2);
			expect(events[0]).toMatchObject({ type: "killed", source: "ui" });
			expect(events[0].job.id).toBe("bg-1");
			expect(events[1]).toMatchObject({ type: "killed", source: "tool" });
			unsubscribe();
			seedJob({ id: "bg-3" });
			killBashBackgroundJob("bg-3", "ui");
			expect(events).toHaveLength(2);
		} finally {
			unsubscribe();
		}
	});

	it("a throwing listener never breaks the kill path (or other listeners)", () => {
		const seen: string[] = [];
		const unsubBad = onBashBackgroundJobEvent(() => {
			throw new Error("listener boom");
		});
		const unsubGood = onBashBackgroundJobEvent((event) => seen.push(event.type));
		try {
			seedJob({ id: "bg-1" });
			expect(killBashBackgroundJob("bg-1", "ui")).toBe(true);
			expect(seen).toEqual(["killed"]);
		} finally {
			unsubBad();
			unsubGood();
		}
	});
});

describe("bash tool jobId surface: wait + poll format", () => {
	const def = createBashToolDefinition(process.cwd());
	const ctx = {} as Parameters<typeof def.execute>[4];
	type ToolResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };
	const run = async (args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> =>
		(await def.execute("call-job", args as never, signal, undefined, ctx)) as ToolResult;
	const textOf = (result: ToolResult) => result.content[0]?.text ?? "";

	it("wait returns as soon as the job exits, marking the result seen", async () => {
		const job = seedJob({ id: "bg-1", ringBuffer: "built ok\n" });
		setTimeout(() => {
			job.exited = true;
			job.exitCode = 0;
		}, 300);
		const start = Date.now();
		const result = await run({ jobId: "bg-1", action: "wait", timeout: 10 });
		expect(Date.now() - start).toBeLessThan(5_000);
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toContain("exited with code 0");
		expect(textOf(result)).toContain("built ok");
		expect(job.resultSeen).toBe(true);
	});

	it("wait deadline elapses on a job that keeps running", async () => {
		seedJob({ id: "bg-1" });
		const result = await run({ jobId: "bg-1", action: "wait", timeout: 1 });
		expect(textOf(result)).toContain("Wait deadline (1s) elapsed");
		expect(textOf(result)).toContain("still running");
	});

	it("a job killed mid-wait reports the kill instead of a stale snapshot", async () => {
		seedJob({ id: "bg-1" });
		setTimeout(() => killBashBackgroundJob("bg-1", "ui"), 300);
		const result = await run({ jobId: "bg-1", action: "wait", timeout: 10 });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("killed while waiting");
	});

	it("poll on a running job reports last-output age; a stalled job carries the kill hint", async () => {
		process.env.PIT_BASH_STALL_SECONDS = "10";
		seedJob({
			id: "bg-1",
			ringBuffer: "line\n",
			lastOutputAt: Date.now() - 60_000,
			promotedAt: Date.now() - 60_000,
		});
		const result = await run({ jobId: "bg-1" });
		expect(textOf(result)).toMatch(/last output \d+(\.\d+)?s ago/);
		expect(textOf(result)).toContain('action:"kill"');
		expect(textOf(result)).toContain("Possibly hung");
	});

	it("poll on a healthy running job has no stall hint; exited poll marks resultSeen", async () => {
		process.env.PIT_BASH_STALL_SECONDS = "3600";
		const running = seedJob({ id: "bg-1", ringBuffer: "x\n", lastOutputAt: Date.now() });
		expect(textOf(await run({ jobId: "bg-1" }))).not.toContain("Possibly hung");
		expect(running.resultSeen).toBe(false);
		const exited = seedJob({ id: "bg-2", exited: true, exitCode: 3 });
		const result = await run({ jobId: "bg-2" });
		expect(textOf(result)).toContain("exited with code 3");
		expect(exited.resultSeen).toBe(true);
	});

	it("wait on an already-exited job returns immediately like a poll", async () => {
		seedJob({ id: "bg-1", exited: true, exitCode: 1, ringBuffer: "boom\n" });
		const start = Date.now();
		const result = await run({ jobId: "bg-1", action: "wait" });
		expect(Date.now() - start).toBeLessThan(500);
		expect(textOf(result)).toContain("exited with code 1");
	});

	it("an aborted wait returns the current snapshot instead of hanging", async () => {
		seedJob({ id: "bg-1" });
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 200);
		const start = Date.now();
		const result = await run({ jobId: "bg-1", action: "wait", timeout: 30 }, controller.signal);
		expect(Date.now() - start).toBeLessThan(5_000);
		expect(textOf(result)).toContain("still running");
	});
});

describe("registry integrity", () => {
	it("getBashBackgroundJob returns the seeded instance until killed", () => {
		const job = seedJob({ id: "bg-9" });
		expect(getBashBackgroundJob("bg-9")).toBe(job);
		killBashBackgroundJob("bg-9", "shutdown");
		expect(getBashBackgroundJob("bg-9")).toBeUndefined();
	});
});
