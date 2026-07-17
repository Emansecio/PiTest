/**
 * Integration test for the end-of-turn background-check guard: when the agent
 * backgrounds a test/check that is still running as the turn ends, the session
 * waits for it to settle and re-injects the outcome so it never reports done /
 * suggests a commit on an unfinished or failed test.
 */

import { fauxAssistantMessage } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	type BashBackgroundJob,
} from "../src/core/tools/bash.js";
import { createHarness, getUserTexts, type Harness } from "./suite/harness.js";

const FAILED_MARKER = "has FAILED";
const RUNNING_MARKER = "is STILL running";

// pollIntervalMs shrinks the drain's re-check cadence so a job that settles a few
// ms after the turn ends is detected almost immediately instead of after a fixed
// 500ms poll — the assertions (pass/fail/re-injection) are unchanged.
const pendingChecksOn = {
	pendingChecks: { enabled: true, maxWaitMs: 5000, maxFixAttempts: 1, pollIntervalMs: 20 },
};

function bgJob(over: Partial<BashBackgroundJob>): BashBackgroundJob {
	return {
		id: "bg-1",
		pid: 1,
		command: "npm run check",
		startedAt: 0,
		promotedAt: 0,
		exited: false,
		exitCode: null,
		ringBuffer: "",
		ringTruncated: false,
		kill: () => {},
		...over,
	};
}

describe("background-check guard", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		_resetBashBackgroundJobsForTest();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("waits for a running check, then re-injects its failure", async () => {
		const harness = await createHarness({ settings: pendingChecksOn });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("All done — you can commit."),
			fauxAssistantMessage("understood, I'll wait and fix it"),
		]);

		const job = bgJob({
			id: "bg-7",
			command: "npm run check",
			exited: false,
			ringBuffer: "src/foo.ts(9,1): error TS2304: Cannot find name 'bar'.",
		});
		_registerBashBackgroundJobForTest(job);
		// The check finishes (red) shortly after the turn ends.
		setTimeout(() => {
			job.exited = true;
			job.exitCode = 1;
		}, 50);

		await harness.session.prompt("ship the feature");

		const failed = harness.eventsOfType("pending_check").filter((e) => e.phase === "failed");
		expect(failed.length).toBe(1);
		const texts = getUserTexts(harness);
		expect(texts.some((t) => t.includes(FAILED_MARKER))).toBe(true);
		expect(texts.some((t) => t.includes("error TS2304"))).toBe(true);
		expect(texts.some((t) => t.includes("bg-7"))).toBe(true);
	});

	it("re-injects a 'still running' warning when the check never settles in time", async () => {
		const harness = await createHarness({
			// Job never settles: the drain must wait out maxWaitMs and then warn. Keep
			// that wait short (200ms) with a fast poll so the "still running" path is
			// proven without a full second of real waiting.
			settings: { pendingChecks: { enabled: true, maxWaitMs: 200, maxFixAttempts: 1, pollIntervalMs: 20 } },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("Done — ready to commit."),
			fauxAssistantMessage("ok, I'll wait for the test"),
		]);

		_registerBashBackgroundJobForTest(bgJob({ id: "bg-8", command: "npm test", exited: false }));

		await harness.session.prompt("ship it");

		const texts = getUserTexts(harness);
		expect(texts.some((t) => t.includes(RUNNING_MARKER))).toBe(true);
		expect(texts.some((t) => t.includes("bg-8"))).toBe(true);
	});

	it("stays silent when the backgrounded check finished green", async () => {
		const harness = await createHarness({ settings: pendingChecksOn });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("All done.")]);

		const job = bgJob({ id: "bg-9", command: "npm run check", exited: false });
		_registerBashBackgroundJobForTest(job);
		setTimeout(() => {
			job.exited = true;
			job.exitCode = 0;
		}, 50);

		await harness.session.prompt("ship it");

		const v = harness.eventsOfType("pending_check");
		expect(v.some((e) => e.phase === "passed")).toBe(true);
		expect(getUserTexts(harness)).toEqual(["ship it"]);
	});

	it("ignores a backgrounded dev server (not a check)", async () => {
		const harness = await createHarness({ settings: pendingChecksOn });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("All done.")]);

		_registerBashBackgroundJobForTest(bgJob({ id: "bg-10", command: "npm run dev", exited: false }));

		await harness.session.prompt("start the server");

		expect(harness.eventsOfType("pending_check")).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["start the server"]);
	});

	it("does nothing when pendingChecks.enabled is false", async () => {
		const harness = await createHarness({
			settings: { pendingChecks: { enabled: false } },
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("All done.")]);

		_registerBashBackgroundJobForTest(bgJob({ id: "bg-11", command: "npm run check", exited: false }));

		await harness.session.prompt("ship it");

		expect(harness.eventsOfType("pending_check")).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["ship it"]);
	});
});
