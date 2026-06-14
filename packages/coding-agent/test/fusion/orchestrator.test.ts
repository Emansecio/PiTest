import { describe, expect, it } from "vitest";
import { runFusionTurn } from "../../src/core/fusion/orchestrator.ts";
import type { JudgeAnalysis, PanelMember, PanelResult } from "../../src/core/fusion/types.ts";

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
});
