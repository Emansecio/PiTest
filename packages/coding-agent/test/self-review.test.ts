import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GoalManager, setCurrentGoalManager } from "../src/core/goal/goal-manager.js";
import {
	buildSelfReviewPrompt,
	clearCurrentSelfReviewFindings,
	getCurrentSelfReviewFindings,
	runSelfReviewLoop,
	SELF_REVIEW_SYSTEM_PROMPT,
	type SelfReviewFinding,
	type SelfReviewResult,
	type SelfReviewRunner,
	selfReviewFixPrompt,
	selfReviewTriggerReason,
	setCurrentSelfReviewFindings,
} from "../src/core/self-review.ts";
import type { SupervisionLevel } from "../src/core/supervision-thermostat.ts";
import { createGoalCompleteToolDefinition } from "../src/core/tools/goal-complete.js";
import type { TurnRiskTotals } from "../src/core/turn-risk.ts";

function totals(over: Partial<TurnRiskTotals>): TurnRiskTotals {
	return {
		mutations: 1,
		changedLines: 200,
		aggregateRisk: "high",
		maxPatchRisk: "low",
		touchedFiles: [{ path: "a.ts", changedLines: 200 }],
		...over,
	};
}

function highFinding(over: Partial<SelfReviewFinding> = {}): SelfReviewFinding {
	return { claim: "off-by-one in loop bound", severity: "high", file: "a.ts", evidence: "for i <= n", ...over };
}

/** A runner that returns a scripted sequence of results, one per call. */
function scriptedRunner(sequence: SelfReviewResult[]): { runner: SelfReviewRunner; calls: () => number } {
	let call = 0;
	const runner: SelfReviewRunner = async () => {
		const result = sequence[Math.min(call, sequence.length - 1)];
		call++;
		return result;
	};
	return { runner, calls: () => call };
}

describe("selfReviewTriggerReason", () => {
	const cases: Array<[string, Partial<TurnRiskTotals>, SupervisionLevel | undefined, string]> = [
		["high aggregate fires at leve", { aggregateRisk: "high", maxPatchRisk: "low" }, "leve", "high"],
		[
			"high single patch fires at leve",
			{ aggregateRisk: "low", maxPatchRisk: "high", changedLines: 30 },
			"leve",
			"high",
		],
		["high fires at padrao", { aggregateRisk: "high" }, "padrao", "high"],
		[
			"medium fires only at assistido",
			{ aggregateRisk: "medium", changedLines: 60 },
			"assistido",
			"medium-assistido",
		],
		["medium is inert at padrao", { aggregateRisk: "medium", changedLines: 60 }, "padrao", "none"],
		["medium is inert at leve", { aggregateRisk: "medium", changedLines: 60 }, "leve", "none"],
		[
			"medium is inert when level undefined (→padrao)",
			{ aggregateRisk: "medium", changedLines: 60 },
			undefined,
			"none",
		],
	];
	for (const [name, over, level, expected] of cases) {
		it(name, () => {
			expect(selfReviewTriggerReason(totals(over), level)).toBe(expected);
		});
	}

	it("never fires on a zero-mutation cycle even at high risk", () => {
		expect(selfReviewTriggerReason(totals({ mutations: 0 }), "assistido")).toBe("none");
	});
});

describe("runSelfReviewLoop", () => {
	const original = process.env.PIT_NO_SELF_REVIEW;

	beforeEach(() => {
		delete process.env.PIT_NO_SELF_REVIEW;
		resetRuntimeDiagnostics();
		clearCurrentSelfReviewFindings();
	});

	afterEach(() => {
		if (original === undefined) delete process.env.PIT_NO_SELF_REVIEW;
		else process.env.PIT_NO_SELF_REVIEW = original;
		clearCurrentSelfReviewFindings();
	});

	it("does not run when no trigger fires (medium at padrao)", async () => {
		const { runner, calls } = scriptedRunner([{ findings: [highFinding()] }]);
		const injected: string[] = [];
		const r = await runSelfReviewLoop({
			totals: totals({ aggregateRisk: "medium", changedLines: 60 }),
			level: "padrao",
			runner,
			maxAttempts: 3,
			fixesAlreadyUsed: 0,
			injectFix: async (p) => {
				injected.push(p);
			},
		});
		expect(r.ran).toBe(false);
		expect(calls()).toBe(0);
		expect(injected).toHaveLength(0);
	});

	it("is a no-op under the PIT_NO_SELF_REVIEW kill-switch", async () => {
		process.env.PIT_NO_SELF_REVIEW = "1";
		const { runner, calls } = scriptedRunner([{ findings: [highFinding()] }]);
		const r = await runSelfReviewLoop({
			totals: totals({}),
			level: "assistido",
			runner,
			maxAttempts: 3,
			fixesAlreadyUsed: 0,
			injectFix: async () => {},
			env: process.env,
		});
		expect(r.ran).toBe(false);
		expect(calls()).toBe(0);
	});

	it("runs but injects nothing on a clean review", async () => {
		const { runner } = scriptedRunner([{ findings: [] }]);
		const injected: string[] = [];
		const r = await runSelfReviewLoop({
			totals: totals({}),
			level: "leve",
			runner,
			maxAttempts: 3,
			fixesAlreadyUsed: 0,
			injectFix: async (p) => {
				injected.push(p);
			},
		});
		expect(r.ran).toBe(true);
		expect(r.unresolvedHigh).toHaveLength(0);
		expect(injected).toHaveLength(0);
		expect(getCurrentSelfReviewFindings()).toHaveLength(0);
		// A review-ran diagnostic was emitted.
		const diag = getRuntimeDiagnostics().recent.find((e) => e.context?.ruleId === "review-ran");
		expect(diag?.category).toBe("quality.self-review");
	});

	it("re-injects a fix prompt for HIGH findings, then clears when the re-review is clean", async () => {
		const finding = highFinding();
		const { runner, calls } = scriptedRunner([{ findings: [finding] }, { findings: [] }]);
		const injected: string[] = [];
		const r = await runSelfReviewLoop({
			totals: totals({}),
			level: "leve",
			runner,
			maxAttempts: 3,
			fixesAlreadyUsed: 0,
			injectFix: async (p) => {
				injected.push(p);
			},
		});
		expect(calls()).toBe(2); // reviewed, injected fix, re-reviewed
		expect(injected).toHaveLength(1);
		expect(injected[0]).toContain(finding.claim);
		expect(injected[0]).toContain(finding.evidence);
		expect(r.fixesUsed).toBe(1);
		expect(r.unresolvedHigh).toHaveLength(0);
		// Cleared once the diff reviews clean.
		expect(getCurrentSelfReviewFindings()).toHaveLength(0);
	});

	it("shares the verification budget: no re-inject when it is already spent", async () => {
		const finding = highFinding();
		const { runner, calls } = scriptedRunner([{ findings: [finding] }, { findings: [] }]);
		const injected: string[] = [];
		const r = await runSelfReviewLoop({
			totals: totals({}),
			level: "leve",
			runner,
			maxAttempts: 2,
			fixesAlreadyUsed: 2, // verification already used the whole budget
			injectFix: async (p) => {
				injected.push(p);
			},
		});
		expect(calls()).toBe(1); // reviewed once, but no budget to inject/re-review
		expect(injected).toHaveLength(0);
		expect(r.unresolvedHigh).toHaveLength(1);
		// Left registered so goal_complete (R9) still blocks.
		expect(getCurrentSelfReviewFindings()).toHaveLength(1);
	});

	it("fails open when the runner throws", async () => {
		const runner: SelfReviewRunner = async () => {
			throw new Error("subagent timed out");
		};
		const injected: string[] = [];
		const r = await runSelfReviewLoop({
			totals: totals({}),
			level: "assistido",
			runner,
			maxAttempts: 3,
			fixesAlreadyUsed: 0,
			injectFix: async (p) => {
				injected.push(p);
			},
		});
		expect(r.ran).toBe(true);
		expect(r.unresolvedHigh).toHaveLength(0);
		expect(injected).toHaveLength(0);
		expect(getCurrentSelfReviewFindings()).toHaveLength(0);
		const diag = getRuntimeDiagnostics().recent.find((e) => e.context?.ruleId === "review-fail-open");
		expect(diag?.category).toBe("quality.self-review");
	});

	it("medium findings alone never block or inject (only high do)", async () => {
		const { runner } = scriptedRunner([
			{ findings: [{ claim: "naming", severity: "medium", file: "a.ts", evidence: "x" }] },
		]);
		const injected: string[] = [];
		const r = await runSelfReviewLoop({
			totals: totals({}),
			level: "assistido",
			runner,
			maxAttempts: 3,
			fixesAlreadyUsed: 0,
			injectFix: async (p) => {
				injected.push(p);
			},
		});
		expect(injected).toHaveLength(0);
		expect(r.unresolvedHigh).toHaveLength(0);
		expect(getCurrentSelfReviewFindings()).toHaveLength(0);
	});
});

describe("self-review prompts", () => {
	it("system prompt carries the high-risk rubric and forbids style nits", () => {
		expect(SELF_REVIEW_SYSTEM_PROMPT).toContain("Edge cases covered");
		expect(SELF_REVIEW_SYSTEM_PROMPT).toContain("EMPTY findings array");
		expect(SELF_REVIEW_SYSTEM_PROMPT.toLowerCase()).toContain("style nits");
	});

	it("user prompt lists touched files and embeds diffs when present", () => {
		const prompt = buildSelfReviewPrompt(
			totals({ touchedFiles: [{ path: "a.ts", changedLines: 130, diff: "-old\n+new" }] }),
		);
		expect(prompt).toContain("a.ts — 130 changed lines");
		expect(prompt).toContain("```diff");
		expect(prompt).toContain("+new");
	});

	it("fix prompt names each finding with its evidence", () => {
		const p = selfReviewFixPrompt([highFinding({ claim: "null deref", evidence: "user.name" })]);
		expect(p).toContain("high-severity problems");
		expect(p).toContain("null deref");
		expect(p).toContain("user.name");
	});
});

describe("goal_complete R9 (unresolved high self-review findings)", () => {
	const tool = createGoalCompleteToolDefinition(process.cwd());
	function complete(id: string, summary: string) {
		return tool.execute(id, { summary }, undefined, undefined, undefined as never);
	}
	function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("\n");
	}

	afterEach(() => {
		clearCurrentSelfReviewFindings();
		setCurrentGoalManager(undefined);
		resetRuntimeDiagnostics();
	});

	it("refuses completion while high findings are registered, then completes once cleared", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		setCurrentSelfReviewFindings([highFinding({ claim: "unhandled null", evidence: "cfg.value" })]);
		const blocked = await complete("c1", "done");
		expect(blocked.details?.completed).toBe(false);
		expect(textOf(blocked)).toContain("unresolved high-severity");
		expect(textOf(blocked)).toContain("unhandled null");
		expect(mgr.get()?.status).toBe("active");
		// The block emits a review-blocked-done diagnostic.
		const diag = getRuntimeDiagnostics().recent.find((e) => e.context?.ruleId === "review-blocked-done");
		expect(diag?.category).toBe("quality.self-review");

		clearCurrentSelfReviewFindings();
		const ok = await complete("c2", "done");
		expect(ok.details?.completed).toBe(true);
		expect(mgr.get()?.status).toBe("complete");
	});
});
