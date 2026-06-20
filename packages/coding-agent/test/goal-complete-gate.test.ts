/**
 * Unit test for R7: goal_complete refuses to finish while the project check is
 * red, consulting the session-published verification probe.
 */
import { afterEach, describe, expect, it } from "vitest";
import { GoalManager, setCurrentGoalManager } from "../src/core/goal/goal-manager.js";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	type BashBackgroundJob,
} from "../src/core/tools/bash.js";
import { createGoalCompleteToolDefinition } from "../src/core/tools/goal-complete.js";
import { setCurrentVerificationProbe } from "../src/core/verification/verification.js";

const tool = createGoalCompleteToolDefinition(process.cwd());

// goal_complete ignores signal/onUpdate/ctx; pass placeholders to satisfy the
// 5-arg ToolDefinition.execute signature.
function complete(id: string, summary: string) {
	return tool.execute(id, { summary }, undefined, undefined, undefined as never);
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

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

describe("goal_complete background-check gate (R8)", () => {
	afterEach(() => {
		_resetBashBackgroundJobsForTest();
		setCurrentVerificationProbe(undefined);
		setCurrentGoalManager(undefined);
	});

	it("refuses while a backgrounded test/check is still running", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }));
		_registerBashBackgroundJobForTest(bgJob({ id: "bg-7", command: "npm run check", exited: false }));

		const r = await complete("c1", "done");
		expect(r.details?.completed).toBe(false);
		expect(textOf(r)).toContain("still running in the background");
		expect(textOf(r)).toContain("bg-7");
		expect(mgr.get()?.status).toBe("active");
	});

	it("completes once the backgrounded check has exited (and the probe is green)", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }));
		_registerBashBackgroundJobForTest(bgJob({ id: "bg-8", command: "npm run check", exited: true, exitCode: 0 }));

		const r = await complete("c1", "done");
		expect(r.details?.completed).toBe(true);
		expect(mgr.get()?.status).toBe("complete");
	});

	it("ignores a backgrounded dev server (not a check)", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }));
		_registerBashBackgroundJobForTest(bgJob({ id: "bg-9", command: "npm run dev", exited: false }));

		const r = await complete("c1", "done");
		expect(r.details?.completed).toBe(true);
	});
});

describe("goal_complete verification gate (R7)", () => {
	it("refuses while the check is red, then completes once it is green", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		try {
			setCurrentVerificationProbe(async () => ({
				ok: false,
				exitCode: 1,
				output: "type error in foo.ts",
				timedOut: false,
			}));
			const red = await complete("c1", "done");
			expect(red.details?.completed).toBe(false);
			expect(textOf(red)).toContain("Not completing");
			expect(textOf(red)).toContain("type error in foo.ts");
			expect(mgr.get()?.status).toBe("active");

			setCurrentVerificationProbe(async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }));
			const green = await complete("c2", "done");
			expect(green.details?.completed).toBe(true);
			expect(mgr.get()?.status).toBe("complete");
		} finally {
			setCurrentVerificationProbe(undefined);
			setCurrentGoalManager(undefined);
		}
	});

	it("summarizes the dominant failure (tsc) instead of dumping the raw tail", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		// A long, noisy probe output with one load-bearing tsc error buried in the
		// MIDDLE — far enough from the end that a raw `slice(-2000)` tail would lose
		// it under the trailing progress noise.
		const tscError = "src/widgets/foo.ts(42,7): error TS2322: Type 'string' is not assignable to type 'number'.";
		const noise = Array.from({ length: 120 }, (_, i) => `  ✓ some/passing/spec-${i}.test.ts passed`).join("\n");
		const output = `${noise}\n${tscError}\n${noise}`;
		setCurrentVerificationProbe(async () => ({ ok: false, exitCode: 2, output, timedOut: false }));
		try {
			const red = await complete("c1", "done");
			expect(red.details?.completed).toBe(false);
			expect(textOf(red)).toContain("Not completing");
			// The extracted root-cause line is present…
			expect(textOf(red)).toContain(tscError);
			// …and the passing-spec noise was dropped (proves summary, not raw tail).
			expect(textOf(red)).not.toContain("some/passing/spec-119.test.ts");
			expect(mgr.get()?.status).toBe("active");
		} finally {
			setCurrentVerificationProbe(undefined);
			setCurrentGoalManager(undefined);
		}
	});

	it("completes when no probe is registered", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(undefined);
		try {
			const r = await complete("c1", "ok");
			expect(r.details?.completed).toBe(true);
		} finally {
			setCurrentGoalManager(undefined);
		}
	});

	it("completes when the probe returns null (verification off or no command)", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => null);
		try {
			const r = await complete("c1", "ok");
			expect(r.details?.completed).toBe(true);
		} finally {
			setCurrentVerificationProbe(undefined);
			setCurrentGoalManager(undefined);
		}
	});
});
