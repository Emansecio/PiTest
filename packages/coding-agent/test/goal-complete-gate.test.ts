/**
 * Unit test for R7: goal_complete refuses to finish while the project check is
 * red, consulting the session-published verification probe.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetImpactStateForTest, _setUnreviewedImpactForTest } from "../src/core/built-ins/impact-extension.js";
import { GoalManager, getCurrentGoalManager, setCurrentGoalManager } from "../src/core/goal/goal-manager.js";
import {
	_registerBashBackgroundJobForTest,
	_resetBashBackgroundJobsForTest,
	type BashBackgroundJob,
} from "../src/core/tools/bash.js";
import { createGoalCompleteToolDefinition } from "../src/core/tools/goal-complete.js";
import { goalGateFingerprint } from "../src/core/verification/goal-gates.js";
import { setCurrentVerificationProbe, setCurrentVerificationSettings } from "../src/core/verification/verification.js";

const tool = createGoalCompleteToolDefinition(process.cwd());

// goal_complete ignores signal/onUpdate/ctx; pass placeholders to satisfy the
// 5-arg ToolDefinition.execute signature.
function complete(id: string, summary: string, definition = tool) {
	const contract = getCurrentGoalManager()?.get()?.contract;
	if (!contract) throw new Error("active Goal contract required by test helper");
	return definition.execute(
		id,
		{
			summary,
			contractRevision: contract.revision,
			criteria: contract.criteria.map((criterion) => ({
				id: criterion.id,
				outcome: `${criterion.text} completed`,
				evidence: [{ kind: "path" as const, path: "package.json", note: "verified by the focused test fixture" }],
			})),
		},
		undefined,
		undefined,
		undefined as never,
	);
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
		lastOutputAt: 0,
		resultSeen: false,
		ringBuffer: "",
		ringTruncated: false,
		kill: () => {},
		...over,
	};
}

describe("goal_complete background-check gate (R8)", () => {
	afterEach(() => {
		_resetImpactStateForTest();
		_resetBashBackgroundJobsForTest();
		setCurrentVerificationProbe(undefined);
		setCurrentVerificationSettings(undefined);
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

	it("refuses an owned pending verification job even when resultSeen is true", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }));
		_registerBashBackgroundJobForTest(
			bgJob({ id: "bg-seen-pending", command: "npm run check", exited: false, resultSeen: true }),
		);

		const r = await complete("c1", "done");

		expect(r.details?.completed).toBe(false);
		expect(textOf(r)).toContain("still running in the background");
		expect(mgr.get()?.status).toBe("active");
	});

	it("ignores a pending verification job owned by another session", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }));
		_registerBashBackgroundJobForTest(
			bgJob({ id: "foreign-bg", ownerSessionId: "other-session", command: "npm run check", exited: false }),
		);
		const ownedTool = createGoalCompleteToolDefinition(process.cwd(), { getOwnerSessionId: () => "active-session" });
		const contract = mgr.get()?.contract;
		if (!contract) throw new Error("active Goal contract required by test");

		const r = await ownedTool.execute(
			"c1",
			{
				summary: "done",
				contractRevision: contract.revision,
				criteria: contract.criteria.map((criterion) => ({
					id: criterion.id,
					outcome: `${criterion.text} completed`,
					evidence: [{ kind: "claim", note: "verified by the focused test fixture" }],
				})),
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(r.details?.completed).toBe(true);
		expect(mgr.get()?.status).toBe("complete");
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

	it.each([
		["failed", { exitCode: 1 }],
		["timed out", { exitCode: null, timedOut: true }],
	] as const)("blocks a %s verification job only until its result has been observed", async (_label, terminal) => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => ({ ok: true, exitCode: 0, output: "", timedOut: false }));
		const job = bgJob({ id: "bg-terminal", command: "npm run check", exited: true, ...terminal });
		_registerBashBackgroundJobForTest(job);

		const unseen = await complete("c1", "done");
		expect(unseen.details?.completed).toBe(false);
		expect(textOf(unseen)).toContain("failed or timed out");

		job.resultSeen = true;
		const observed = await complete("c2", "done");
		expect(observed.details?.completed).toBe(true);
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
	afterEach(() => {
		_resetImpactStateForTest();
		_resetBashBackgroundJobsForTest();
		setCurrentVerificationProbe(undefined);
		setCurrentVerificationSettings(undefined);
		setCurrentGoalManager(undefined);
	});

	it("requires the active Goal contract instead of accepting a summary alone", async () => {
		const mgr = new GoalManager();
		const goal = mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		const r = await tool.execute("c1", { summary: "done" }, undefined, undefined, undefined as never);

		expect(r.details).toMatchObject({
			completed: false,
			code: "contract-required",
			pendingCriteria: goal.contract?.criteria.map((criterion) => criterion.id),
		});
		expect(textOf(r)).toContain(`provide contractRevision ${goal.contract?.revision}`);
		expect(mgr.get()?.status).toBe("active");
	});

	it("rejects a completion receipt larger than 24 KiB with an actionable error", async () => {
		const mgr = new GoalManager();
		const objective = `Requirements:\n${Array.from({ length: 16 }, (_, index) => `${index + 1}. criterion ${index + 1}`).join("\n")}`;
		const goal = mgr.start(objective, {});
		setCurrentGoalManager(mgr);
		const contract = goal.contract;
		if (!contract) throw new Error("active Goal contract required by test");

		const r = await tool.execute(
			"c1",
			{
				summary: "done",
				contractRevision: contract.revision,
				criteria: contract.criteria.map((criterion) => ({
					id: criterion.id,
					outcome: "o".repeat(600),
					evidence: Array.from({ length: 6 }, () => ({ kind: "claim" as const, note: "n".repeat(400) })),
				})),
			},
			undefined,
			undefined,
			undefined as never,
		);

		expect(r.details).toMatchObject({ completed: false, code: "receipt-too-large" });
		expect(textOf(r)).toContain("24 KiB");
		expect(textOf(r)).toContain("Shorten criterion outcomes or evidence notes");
		expect(mgr.get()?.status).toBe("active");
	});

	it("rejects completion when the Goal changes while an asynchronous probe is running", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		let releaseProbe:
			| ((result: { ok: boolean; exitCode: number; output: string; timedOut: boolean }) => void)
			| undefined;
		setCurrentVerificationProbe(
			() =>
				new Promise((resolve) => {
					releaseProbe = resolve;
				}),
		);

		const completion = complete("c1", "done");
		await vi.waitFor(() => expect(releaseProbe).toBeTypeOf("function"));
		mgr.edit("ship the changed objective");
		releaseProbe?.({ ok: true, exitCode: 0, output: "", timedOut: false });
		const r = await completion;

		expect(r.details).toMatchObject({ completed: false, code: "goal-changed" });
		expect(textOf(r)).toContain("Goal changed while verification was running");
		expect(mgr.get()).toMatchObject({ status: "active", objective: "ship the changed objective" });
	});

	it("skips mutation gates when verification is disabled", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		mgr.recordMutation("package.json");
		setCurrentGoalManager(mgr);
		setCurrentVerificationSettings(() => ({
			enabled: false,
			command: 'node -e "process.exit(1)"',
			timeoutMs: 1_000,
		}));

		const r = await complete("c1", "done");

		expect(r.details?.completed).toBe(true);
		expect(r.details?.receipt?.verification).toMatchObject({
			mechanism: "none",
			status: "inapplicable",
			reason: "verification disabled",
		});
		expect(mgr.get()?.status).toBe("complete");
	});

	it("records mutation verification as inapplicable when no gate can be detected", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pit-goal-no-gates-"));
		try {
			writeFileSync(join(cwd, "package.json"), "{}", "utf8");
			const mgr = new GoalManager();
			mgr.start("ship it", {});
			mgr.recordMutation();
			setCurrentGoalManager(mgr);
			const noGateTool = createGoalCompleteToolDefinition(cwd);

			const r = await complete("c1", "done", noGateTool);

			expect(r.details?.code).toBeUndefined();
			expect(r.details).toMatchObject({ completed: true });
			expect(r.details?.receipt?.verification).toMatchObject({
				mechanism: "goal-gates",
				status: "inapplicable",
				reason: "no applicable local toolchain",
				gates: [],
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("records invocation gate metadata and marks only truly skipped gates as cached", async () => {
		setCurrentVerificationSettings(() => ({
			enabled: true,
			command: 'node -e "process.exit(0)"',
			timeoutMs: 1_000,
		}));
		const executedManager = new GoalManager();
		executedManager.start("run the gate", {});
		executedManager.recordMutation("package.json");
		executedManager.setGateProgress(1, ["stale-id"]);
		setCurrentGoalManager(executedManager);

		const executed = await complete("c1", "done");

		expect(executed.details?.receipt?.verification.gates).toEqual([
			{
				id: "configured",
				label: "configured verification",
				source: "configured",
				status: "passed",
				cached: false,
				durationMs: expect.any(Number),
			},
		]);

		const cachedManager = new GoalManager();
		cachedManager.start("reuse the gate", {});
		cachedManager.recordMutation("package.json");
		const configuredGate = {
			id: "configured",
			label: "configured verification",
			command: 'node -e "process.exit(0)"',
			source: "configured" as const,
		};
		cachedManager.setGateProgress(1, ["configured"], {
			configured: goalGateFingerprint(configuredGate),
		});
		setCurrentGoalManager(cachedManager);

		const cached = await complete("c2", "done");

		expect(cached.details?.receipt?.verification.gates).toEqual([
			{
				id: "configured",
				label: "configured verification",
				source: "configured",
				status: "passed",
				cached: true,
			},
		]);
	});

	it("reruns a configured gate when its command changes within the mutation revision", async () => {
		let command = 'node -e "process.exit(0)"';
		setCurrentVerificationSettings(() => ({ enabled: true, command, timeoutMs: 1_000 }));
		const mgr = new GoalManager();
		mgr.start("verify the changed command", {});
		mgr.recordMutation("package.json");
		setCurrentGoalManager(mgr);
		_setUnreviewedImpactForTest([{ path: "src/dependent.ts", seeds: ["package.json"] }]);

		const first = await complete("c1", "first gate passed");
		expect(first.details?.completed).toBe(false);
		expect(textOf(first)).toContain("import graph shows 1 file(s)");

		command = 'node -e "process.exit(7)"';
		const second = await complete("c2", "new gate must run");

		expect(second.details?.completed).toBe(false);
		expect(textOf(second)).toContain("configured verification) failed");
		expect(mgr.get()?.status).toBe("active");
	});

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
			expect(r.details?.receipt?.verification).toMatchObject({
				mechanism: "legacy-probe",
				status: "inapplicable",
				reason: "verification probe returned no result",
			});
		} finally {
			setCurrentVerificationProbe(undefined);
			setCurrentGoalManager(undefined);
		}
	});

	it("records a timed-out probe as inapplicable rather than passed", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => ({
			ok: false,
			exitCode: 1,
			output: "killed after timeout",
			timedOut: true,
		}));

		const r = await complete("c1", "ok");

		expect(r.details?.completed).toBe(true);
		expect(r.details?.receipt?.verification).toMatchObject({
			mechanism: "legacy-probe",
			status: "inapplicable",
			reason: "verification probe timed out",
		});
	});

	it("finalizes receipt timing from the GoalManager clock after asynchronous verification", async () => {
		let now = 1_000;
		const mgr = new GoalManager({ now: () => now });
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);
		setCurrentVerificationProbe(async () => {
			now = 2_500;
			return { ok: true, exitCode: 0, output: "", timedOut: false };
		});

		const r = await complete("c1", "done");
		const completed = mgr.get();

		expect(r.details?.completed).toBe(true);
		expect(r.details?.receipt?.completedAt).toBe(2_500);
		expect(r.details?.receipt?.completedAt).toBe(completed?.completedAt);
		expect(r.details?.receipt?.usage.activeMs).toBe(1_500);
		expect(completed?.receipt).toEqual(r.details?.receipt);
	});
});
