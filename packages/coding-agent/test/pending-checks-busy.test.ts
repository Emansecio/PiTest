/**
 * Asserts prompt() stays busy while pending-checks drain polls a running bg job.
 */

import { fauxAssistantMessage } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	type BashBackgroundJob,
} from "../src/core/tools/bash.js";
import { createHarness, type Harness } from "./suite/harness.js";

const pendingChecksOn = {
	verification: { mode: "post-turn" as const },
	pendingChecks: { enabled: true, maxWaitMs: 5000, maxFixAttempts: 1 },
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

describe("pending-checks busy drain", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		_resetBashBackgroundJobsForTest();
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("isBusy stays true during drain until the bg check exits", async () => {
		const harness = await createHarness({ settings: pendingChecksOn });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("All done.")]);

		const job = bgJob({ id: "bg-busy", command: "npm run check", exited: false });
		_registerBashBackgroundJobForTest(job);
		setTimeout(() => {
			job.exited = true;
			job.exitCode = 0;
		}, 100);

		let busyDuringDrain = false;
		const promptDone = harness.session.prompt("ship it");

		while (true) {
			if (harness.session.isBusy) {
				busyDuringDrain = true;
			}
			const done = await Promise.race([
				promptDone.then(() => "done" as const),
				new Promise<"tick">((resolve) => setTimeout(() => resolve("tick"), 5)),
			]);
			if (done === "done") break;
		}

		await promptDone;
		expect(busyDuringDrain).toBe(true);
		expect(harness.session.isBusy).toBe(false);
	});
});
