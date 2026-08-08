import { type Api, getRuntimeDiagnostics, type Model, resetRuntimeDiagnostics } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { SubagentRequestPolicy } from "../src/core/coordinator/types.ts";
import { GoalManager, getCurrentGoalManager, setCurrentGoalManager } from "../src/core/goal/goal-manager.js";
import {
	buildSelfReviewPrompt,
	clearCurrentSelfReviewFindings,
	getCurrentSelfReviewFindings,
	resolveSelfReviewModel,
	runSelfReviewLoop,
	SELF_REVIEW_SESSION_THINKING,
	SELF_REVIEW_SIBLING_THINKING,
	SELF_REVIEW_SYSTEM_PROMPT,
	type SelfReviewFinding,
	type SelfReviewResult,
	type SelfReviewRunner,
	selfReviewFixPrompt,
	selfReviewTriggerReason,
	setCurrentSelfReviewFindings,
} from "../src/core/self-review.ts";
import type { SupervisionLevel } from "../src/core/supervision-thermostat.ts";
import {
	_resetGoalCompleteGateStateForTest,
	createGoalCompleteToolDefinition,
} from "../src/core/tools/goal-complete.js";
import type { TurnRiskTotals } from "../src/core/turn-risk.ts";

const { spawnSubagent } = vi.hoisted(() => ({ spawnSubagent: vi.fn() }));

vi.mock("../src/core/coordinator/index.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/coordinator/index.ts")>();
	return { ...actual, spawnSubagent: (...args: unknown[]) => spawnSubagent(...args) };
});

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

	it("threads impactedFiles through to the runner's prompt (Fase 3)", async () => {
		let seenPrompt = "";
		const runner: SelfReviewRunner = async (args) => {
			seenPrompt = args.prompt;
			return { findings: [] };
		};
		await runSelfReviewLoop({
			totals: totals({}),
			level: "leve",
			runner,
			maxAttempts: 3,
			fixesAlreadyUsed: 0,
			injectFix: async () => {},
			impactedFiles: ["dependent.ts"],
		});
		expect(seenPrompt).toContain("Files that import what changed");
		expect(seenPrompt).toContain("- dependent.ts");
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

describe("resolveSelfReviewModel — small-class sibling routing", () => {
	function model(id: string, provider: string, inputCost?: number): Model<Api> {
		return {
			id,
			name: id,
			api: "anthropic-messages",
			provider,
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: inputCost === undefined ? undefined : { input: inputCost, output: inputCost * 5 },
			contextWindow: 200_000,
			maxTokens: 8192,
		} as Model<Api>;
	}

	const opus = model("claude-opus-4-8", "anthropic", 15);
	const haiku = model("claude-haiku-4-5", "anthropic", 1);
	const otherProviderMini = model("gpt-5-mini", "openai", 0.25);

	it("picks the same-provider sibling and drops thinking to low", () => {
		const r = resolveSelfReviewModel(opus, [opus, haiku, otherProviderMini], {});
		expect(r.model.id).toBe("claude-haiku-4-5");
		expect(r.thinkingLevel).toBe(SELF_REVIEW_SIBLING_THINKING);
		expect(r.usedSibling).toBe(true);
	});

	it("falls back to the session model when the provider has no sibling", () => {
		const r = resolveSelfReviewModel(opus, [opus, otherProviderMini], {});
		expect(r.model.id).toBe(opus.id);
		expect(r.thinkingLevel).toBe(SELF_REVIEW_SESSION_THINKING);
		expect(r.usedSibling).toBe(false);
	});

	it("does not route a session model that is already small-class", () => {
		const r = resolveSelfReviewModel(haiku, [opus, haiku], {});
		expect(r.model.id).toBe(haiku.id);
		expect(r.usedSibling).toBe(false);
	});

	it("PIT_NO_SELF_REVIEW_SIBLING restores the session model (any truthy spelling)", () => {
		for (const value of ["1", "true", "yes"]) {
			const r = resolveSelfReviewModel(opus, [opus, haiku], { PIT_NO_SELF_REVIEW_SIBLING: value });
			expect(r.model.id).toBe(opus.id);
			expect(r.thinkingLevel).toBe(SELF_REVIEW_SESSION_THINKING);
			expect(r.usedSibling).toBe(false);
		}
	});

	it("a falsy kill-switch leaves the sibling default on", () => {
		const r = resolveSelfReviewModel(opus, [opus, haiku], { PIT_NO_SELF_REVIEW_SIBLING: "0" });
		expect(r.usedSibling).toBe(true);
	});
});

describe("AgentSession structured self-review request policy", () => {
	beforeEach(() => spawnSubagent.mockReset());

	it("passes the session request policy to its review subagent", async () => {
		const reviewModel = {
			id: "review-model",
			provider: "review-provider",
		} as Model<Api>;
		const requestPolicy: SubagentRequestPolicy = { streamFn: vi.fn() as never, transport: "sse" };
		const fakeSession = {
			model: reviewModel,
			_resolveSelfReviewModel: async () => ({ model: reviewModel, thinkingLevel: "medium" as const }),
			modelRegistry: {},
			agent: { state: { tools: [] } },
			_cwd: process.cwd(),
			getSubagentRequestPolicy: () => requestPolicy,
		};
		spawnSubagent.mockResolvedValue({ value: { findings: [] } });
		const runner = (
			AgentSession.prototype as unknown as {
				_selfReviewRunner(this: unknown, abort: AbortController): SelfReviewRunner;
			}
		)._selfReviewRunner.call(fakeSession, new AbortController());

		await runner({ prompt: "review", systemPrompt: "review system", totals: totals({}) });

		const requestPolicyFactory = spawnSubagent.mock.calls[0]?.[0]?.requestPolicy as
			| ((signal: AbortSignal) => SubagentRequestPolicy | undefined)
			| undefined;
		const signal = new AbortController().signal;
		expect(requestPolicyFactory?.(signal)).toBe(requestPolicy);
	});
});

describe("self-review prompts", () => {
	it("allows explicitly listed impacted files without widening the review scope", () => {
		expect(SELF_REVIEW_SYSTEM_PROMPT).toContain("explicitly listed impacted files");
		expect(SELF_REVIEW_SYSTEM_PROMPT).toContain("Do NOT review unrelated files");
		expect(SELF_REVIEW_SYSTEM_PROMPT).not.toContain("Do NOT review anything outside the touched files");
	});

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

describe("self-review prompt — Fase 3 impactedFiles (graph escopo expandido)", () => {
	const base = totals({ touchedFiles: [{ path: "a.ts", changedLines: 130 }] });

	it("is byte-identical to the pre-Fase-3 prompt when impactedFiles is omitted", () => {
		expect(buildSelfReviewPrompt(base)).toBe(buildSelfReviewPrompt(base, undefined));
	});

	it("is byte-identical to the pre-Fase-3 prompt when impactedFiles is empty", () => {
		expect(buildSelfReviewPrompt(base, [])).toBe(buildSelfReviewPrompt(base));
	});

	it("appends a read-only impacted-files section when the registry has entries", () => {
		const prompt = buildSelfReviewPrompt(base, ["b.ts", "c.ts"]);
		expect(prompt).toContain("Files that import what changed");
		expect(prompt).toContain("check the change doesn't break how they use it");
		expect(prompt).toContain("- b.ts");
		expect(prompt).toContain("- c.ts");
		// The section is additive: the pre-existing content is still present verbatim.
		expect(prompt).toContain("a.ts — 130 changed lines");
	});

	it("caps the impacted-files section at 10 paths", () => {
		const many = Array.from({ length: 15 }, (_, i) => `impacted${i}.ts`);
		const prompt = buildSelfReviewPrompt(base, many);
		for (const p of many.slice(0, 10)) expect(prompt).toContain(`- ${p}`);
		for (const p of many.slice(10)) expect(prompt).not.toContain(`- ${p}`);
	});
});

describe("goal_complete R9 (unresolved high self-review findings)", () => {
	const tool = createGoalCompleteToolDefinition(process.cwd());
	function complete(id: string, summary: string) {
		const contract = getCurrentGoalManager()?.get()?.contract;
		if (!contract) throw new Error("active Goal contract required by test helper");
		return tool.execute(
			id,
			{
				summary,
				contractRevision: contract.revision,
				criteria: contract.criteria.map((criterion) => ({
					id: criterion.id,
					outcome: `${criterion.text} completed`,
					evidence: [{ kind: "claim" as const, note: "verified by the focused test fixture" }],
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

	afterEach(() => {
		clearCurrentSelfReviewFindings();
		_resetGoalCompleteGateStateForTest();
		setCurrentGoalManager(undefined);
		resetRuntimeDiagnostics();
	});

	it("refuses at most once per goal — a second call completes with findings unchanged", async () => {
		const mgr = new GoalManager();
		mgr.start("ship it", {});
		setCurrentGoalManager(mgr);

		setCurrentSelfReviewFindings([highFinding({ claim: "unhandled null", evidence: "cfg.value" })]);
		expect((await complete("c1", "done")).details?.completed).toBe(false);

		// Findings still registered — the model came back without clearing them (it may
		// consider them false positives). The gate has spent its one refusal, so the
		// goal terminates instead of looping on the same wall.
		const ok = await complete("c2", "done");
		expect(ok.details?.completed).toBe(true);
		expect(ok.details?.receipt?.safeguards.selfReview).toBe("waived");
		expect(mgr.get()?.status).toBe("complete");

		const waived = getRuntimeDiagnostics().recent.find((e) => e.context?.ruleId === "review-gate-waived");
		expect(waived?.category).toBe("quality.self-review");
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
		expect(ok.details?.receipt?.safeguards.selfReview).toBe("passed");
		expect(mgr.get()?.status).toBe("complete");
	});
});
