/**
 * Regression for #21: a bash command aborted inside the background-startup
 * window could still be PROMOTED to a tracked background job. onAbort only
 * killed the tree — it did not clear the promotion timer (autoBgHandle) nor mark
 * settled.done. If the abort fired in the startup window and the process's death
 * event lagged the timer (waitForChildProcess only clears the timer on
 * resolution, which is delayed up to EXIT_STDIO_GRACE_MS after exit), the timer
 * ran promoteToBackground — whose only guard is `if (settled.done) return`,
 * still false — registering a background job for a dying pid and resolving the
 * foreground promise with a "still running" handle instead of rejecting
 * "aborted".
 *
 * The fix marks settled.done + clears autoBgHandle in onAbort, so an abort is
 * authoritative: no promotion, and the waitForChildProcess path rejects
 * "aborted".
 *
 * Determinism: a tiny startup window (20ms) + `sleep 5` (never finishes on its
 * own). The signal is aborted ~5ms in — squarely inside the window. The only
 * legitimate outcome is the "aborted" rejection with NO job registered.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetBashBackgroundJobsForTest,
	createLocalBashOperations,
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

describe("bash: abort in the background-startup window is not promoted (#21)", () => {
	const PREV = process.env.PIT_BASH_BACKGROUND_STARTUP_MS;

	beforeEach(() => {
		_resetBashBackgroundJobsForTest();
		process.env.PIT_BASH_BACKGROUND_STARTUP_MS = "20";
	});

	afterEach(() => {
		killTrackedDetachedChildren();
		for (const job of listBashBackgroundJobs()) job.kill();
		_resetBashBackgroundJobsForTest();
		if (PREV === undefined) delete process.env.PIT_BASH_BACKGROUND_STARTUP_MS;
		else process.env.PIT_BASH_BACKGROUND_STARTUP_MS = PREV;
	});

	it.skipIf(!BASH_AVAILABLE)(
		"backgroundImmediate + abort in the startup window rejects 'aborted' and registers no job",
		async () => {
			const ops = createLocalBashOperations();
			const controller = new AbortController();
			// Abort just inside the 20ms startup window — before promotion would fire.
			const t = setTimeout(() => controller.abort(), 5);

			await expect(
				ops.exec("sleep 5", process.cwd(), {
					autoBackground: true,
					backgroundImmediate: true,
					signal: controller.signal,
					onData: () => undefined,
				}),
			).rejects.toThrow(/abort/i);

			clearTimeout(t);
			// The abort short-circuited promotion: nothing detached, nothing leaked.
			expect(listBashBackgroundJobs()).toHaveLength(0);
		},
		15_000,
	);

	it.skipIf(!BASH_AVAILABLE)(
		"already-aborted signal on entry rejects 'aborted' and registers no job",
		async () => {
			const ops = createLocalBashOperations();
			const controller = new AbortController();
			controller.abort();

			await expect(
				ops.exec("sleep 5", process.cwd(), {
					autoBackground: true,
					backgroundImmediate: true,
					signal: controller.signal,
					onData: () => undefined,
				}),
			).rejects.toThrow(/abort/i);

			expect(listBashBackgroundJobs()).toHaveLength(0);
		},
		15_000,
	);
});
