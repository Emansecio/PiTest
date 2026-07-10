/**
 * Verification commands must NOT be auto-backgrounded — a check that outruns the
 * threshold should block until it finishes (pass/fail known) instead of promoting
 * to a detached job. The agent bash tool disables autoBackground when
 * `isVerificationJobCommand(command)` is true.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetBashBackgroundJobsForTest,
	createBashToolDefinition,
	listBashBackgroundJobs,
} from "../src/core/tools/bash.ts";
import { isVerificationJobCommand } from "../src/core/verification/pending-checks.ts";
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

describe("verification commands and auto-background policy", () => {
	const PREV = process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS;

	beforeEach(() => {
		_resetBashBackgroundJobsForTest();
		process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS = "0.15";
	});

	afterEach(() => {
		killTrackedDetachedChildren();
		for (const job of listBashBackgroundJobs()) job.kill();
		_resetBashBackgroundJobsForTest();
		if (PREV === undefined) delete process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS;
		else process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS = PREV;
	});

	it("classifies npm run check as verification", () => {
		expect(isVerificationJobCommand("npm run check")).toBe(true);
	});

	it.skipIf(!BASH_AVAILABLE)(
		"agent bash path disables autoBackground for verification commands — no promotion before exit",
		async () => {
			// Command label is a check; spawnHook substitutes a short node sleep so the
			// test does not run the real `npm run check`. Threshold is 150ms — if
			// autoBackground were on, promotion would fire before the sleep ends.
			const def = createBashToolDefinition(process.cwd(), {
				spawnHook: (ctx) => ({
					...ctx,
					command: 'node -e "setTimeout(()=>process.exit(0), 400)"',
				}),
			});
			const ctx = {} as Parameters<typeof def.execute>[4];
			const start = Date.now();
			const result = (await def.execute("call-check", { command: "npm run check" }, undefined, undefined, ctx)) as {
				content: Array<{ type: string; text?: string }>;
			};

			// Waited for the full sleep (not promoted at 150ms).
			expect(Date.now() - start).toBeGreaterThanOrEqual(300);
			const text = result.content[0]?.text ?? "";
			expect(text).not.toMatch(/promoted to background id=/i);
			expect(listBashBackgroundJobs()).toHaveLength(0);
		},
		15_000,
	);
});
