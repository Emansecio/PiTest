import { describe, expect, it } from "vitest";
import { runFusionTurn } from "../../src/core/fusion/orchestrator.ts";
import type { JudgeAnalysis, PanelMember, PanelResult, VerificationReport } from "../../src/core/fusion/types.ts";

const PANEL: PanelMember[] = [
	{ cli: "claude", model: "opus" },
	{ cli: "codex", model: "gpt-5.5-codex" },
];
const okResult = (m: PanelMember, text: string): PanelResult => ({ member: m, ok: true, text });
const EMPTY_JUDGE: JudgeAnalysis = {
	consensus: [],
	contradictions: [],
	partialCoverage: [],
	uniqueInsights: [],
	blindSpots: [],
	unsupportedClaims: [],
};

describe("runFusionTurn", () => {
	it("runs both members, judges, and writes", async () => {
		const out = await runFusionTurn({
			userPrompt: "Q",
			panel: PANEL,
			staggerSameCliMs: 0,
			runMember: async (m) => okResult(m, `ans-${m.cli}`),
			runJudge: async () => EMPTY_JUDGE,
			writer: async (_p, results, _a) => `FINAL(${results.filter((r) => r.ok).length})`,
		});
		expect(out.handled).toBe(true);
		expect(out.text).toBe("FINAL(2)");
	});

	it("degrades to 1+synth when one member fails (skips judge)", async () => {
		let judgeCalls = 0;
		let writerAnalysis: JudgeAnalysis | undefined;
		const out = await runFusionTurn({
			userPrompt: "Q",
			panel: PANEL,
			staggerSameCliMs: 0,
			runMember: async (m) =>
				m.cli === "codex" ? { member: m, ok: false, text: "", error: "boom" } : okResult(m, "A"),
			runJudge: async () => {
				judgeCalls++;
				return EMPTY_JUDGE;
			},
			writer: async (_p, results, analysis) => {
				writerAnalysis = analysis;
				return `FINAL(${results.filter((r) => r.ok).length})`;
			},
		});
		expect(out.handled).toBe(true);
		expect(out.text).toBe("FINAL(1)");
		expect(judgeCalls).toBe(0);
		expect(writerAnalysis).toEqual(EMPTY_JUDGE);
	});

	it("returns unhandled when both members fail (caller falls back to solo)", async () => {
		const out = await runFusionTurn({
			userPrompt: "Q",
			panel: PANEL,
			staggerSameCliMs: 0,
			runMember: async (m) => ({ member: m, ok: false, text: "", error: "boom" }),
			runJudge: async () => EMPTY_JUDGE,
			writer: async () => "unused",
		});
		expect(out.handled).toBe(false);
	});

	it("skips runMember for a pre-aborted same-cli member (i>0) and marks it failed", async () => {
		let sameCliCalls = 0;
		const sameCliPanel: PanelMember[] = [
			{ cli: "claude", model: "opus" },
			{ cli: "claude", model: "haiku" },
		];
		const ctrl = new AbortController();
		ctrl.abort();
		const out = await runFusionTurn({
			userPrompt: "Q",
			panel: sameCliPanel,
			staggerSameCliMs: 5,
			signal: ctrl.signal,
			runMember: async (m) => {
				if (m.model === "haiku") sameCliCalls++;
				return okResult(m, "A");
			},
			runJudge: async () => EMPTY_JUDGE,
			writer: async () => "unused",
		});
		// Same-cli member is staggered, then the abort short-circuits it before spawning.
		expect(sameCliCalls).toBe(0);
		// Both members short-circuit on the pre-set abort -> no survivors -> unhandled.
		expect(out.handled).toBe(false);
	});

	it("yields ok:false error:aborted for a same-cli member aborted during the stagger", async () => {
		// Member 0 (different cli, no stagger) survives so the outcome is observable;
		// member 1 (same cli) waits on the stagger, during which we abort.
		const mixedPanel: PanelMember[] = [
			{ cli: "codex", model: "gpt-5.5-codex" },
			{ cli: "codex", model: "gpt-5.5-mini" },
		];
		let sameCliCalls = 0;
		const ctrl = new AbortController();
		let seen: PanelResult[] = [];
		const out = await runFusionTurn({
			userPrompt: "Q",
			panel: mixedPanel,
			staggerSameCliMs: 20,
			signal: ctrl.signal,
			runMember: async (m) => {
				if (m.model === "gpt-5.5-mini") {
					sameCliCalls++;
					return okResult(m, "B");
				}
				// First member runs immediately; trigger the abort while member 1 staggers.
				ctrl.abort();
				return okResult(m, "A");
			},
			runJudge: async () => EMPTY_JUDGE,
			writer: async (_p, results, _a) => {
				seen = results;
				return "FINAL";
			},
		});
		expect(sameCliCalls).toBe(0);
		expect(out.handled).toBe(true);
		const staggered = seen.find((r) => r.member.model === "gpt-5.5-mini");
		expect(staggered?.ok).toBe(false);
		expect(staggered?.error).toBe("aborted");
	});

	it("runs verify between judge and writer and hands the report to the writer", async () => {
		const order: string[] = [];
		let writerVerification: VerificationReport | undefined;
		const report: VerificationReport = { findings: [{ claim: "c", verdict: "refuted", evidence: "e" }] };
		const out = await runFusionTurn({
			userPrompt: "Q",
			panel: PANEL,
			staggerSameCliMs: 0,
			runMember: async (m) => okResult(m, `ans-${m.cli}`),
			runJudge: async () => {
				order.push("judge");
				return EMPTY_JUDGE;
			},
			verify: async () => {
				order.push("verify");
				return report;
			},
			writer: async (_p, _r, _a, verification) => {
				order.push("writer");
				writerVerification = verification;
				return "FINAL";
			},
		});
		expect(out.handled).toBe(true);
		expect(order).toEqual(["judge", "verify", "writer"]);
		expect(writerVerification).toEqual(report);
		expect(out.verification).toEqual(report);
	});

	it("verifies the lone survivor even when the judge is skipped", async () => {
		let judgeCalls = 0;
		let verifyCalls = 0;
		const out = await runFusionTurn({
			userPrompt: "Q",
			panel: PANEL,
			staggerSameCliMs: 0,
			runMember: async (m) =>
				m.cli === "codex" ? { member: m, ok: false, text: "", error: "boom" } : okResult(m, "A"),
			runJudge: async () => {
				judgeCalls++;
				return EMPTY_JUDGE;
			},
			verify: async () => {
				verifyCalls++;
				return { findings: [] };
			},
			writer: async () => "FINAL(1)",
		});
		expect(out.handled).toBe(true);
		expect(judgeCalls).toBe(0);
		expect(verifyCalls).toBe(1);
	});
});
