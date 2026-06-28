import type { Message } from "@pit/ai";
import { describe, expect, it } from "vitest";
import {
	buildJudgeContext,
	buildVerifierPrompt,
	buildWriterContext,
	capPanelText,
	FUSION_PANEL_TEXT_MAX_CHARS,
	JUDGE_SCHEMA,
	parseJudgeOutput,
	shouldSkipFusionVerify,
	VERIFICATION_SCHEMA,
} from "../../src/core/fusion/judge.ts";

describe("fusion judge", () => {
	it("builds a judge system prompt that forces a json block", () => {
		const ctx = buildJudgeContext("Original question", [
			{ member: { cli: "claude", model: "opus" }, ok: true, text: "answer A" },
			{ member: { cli: "codex", model: "gpt-5.5-codex" }, ok: true, text: "answer B" },
		]);
		expect(ctx.systemPrompt).toContain("```json");
		const first = ctx.messages[0];
		const content = typeof first.content === "string" ? first.content : JSON.stringify(first.content);
		expect(content).toContain("answer A");
		expect(content).toContain("answer B");
	});

	it("parses + validates a conforming judge output", () => {
		const json = JSON.stringify({
			consensus: ["x"],
			contradictions: [],
			partialCoverage: [],
			uniqueInsights: ["y"],
			blindSpots: [],
			unsupportedClaims: ["z"],
		});
		const parsed = parseJudgeOutput(`\`\`\`json\n${json}\n\`\`\``);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.value.uniqueInsights).toEqual(["y"]);
			expect(parsed.value.unsupportedClaims).toEqual(["z"]);
		}
		// keep JUDGE_SCHEMA referenced as a public export
		expect(JUDGE_SCHEMA.type).toBe("object");
	});

	it("builds a verifier prompt with the advisor reports + judge-flagged claims", () => {
		const prompt = buildVerifierPrompt(
			"Q",
			[{ member: { cli: "claude", model: "opus" }, ok: true, text: "the report" }],
			{
				consensus: [],
				contradictions: ["contra-1"],
				partialCoverage: [],
				uniqueInsights: ["uniq-1"],
				blindSpots: [],
				unsupportedClaims: ["claim-1"],
			},
		);
		expect(prompt).toContain("the report");
		expect(prompt).toContain("claim-1");
		expect(prompt).toContain("contra-1");
		expect(prompt).toContain("uniq-1");
		expect(VERIFICATION_SCHEMA.type).toBe("object");
	});

	it("rejects malformed judge output", () => {
		expect(parseJudgeOutput("garbage").ok).toBe(false);
		expect(parseJudgeOutput('```json\n{"consensus":"notarray"}\n```').ok).toBe(false);
	});

	const EMPTY_ANALYSIS = {
		consensus: [],
		contradictions: [],
		partialCoverage: [],
		uniqueInsights: [],
		blindSpots: [],
		unsupportedClaims: [],
	};

	it("buildWriterContext is self-contained when no history is passed", () => {
		const ctx = buildWriterContext(
			"the task",
			[{ member: { cli: "claude", model: "opus" }, ok: true, text: "panel answer" }],
			EMPTY_ANALYSIS,
		);
		expect(ctx.messages).toHaveLength(1);
		const only = ctx.messages[0];
		expect(only.role).toBe("user");
		const content = typeof only.content === "string" ? only.content : JSON.stringify(only.content);
		expect(content).toContain("the task");
		expect(content).toContain("panel answer");
	});

	it("caps long panel text in judge context (F1)", () => {
		const long = "x".repeat(FUSION_PANEL_TEXT_MAX_CHARS + 500);
		const ctx = buildJudgeContext("Q", [
			{ member: { cli: "claude", model: "opus" }, ok: true, text: long },
			{ member: { cli: "codex", model: "gpt" }, ok: true, text: "short" },
		]);
		const content = typeof ctx.messages[0].content === "string" ? ctx.messages[0].content : "";
		expect(content).toContain("chars of advisor output elided");
		expect(content).not.toContain("x".repeat(FUSION_PANEL_TEXT_MAX_CHARS + 100));
		expect(content).toContain("short");
	});

	it("capPanelText returns text unchanged when within budget", () => {
		expect(capPanelText("hello")).toBe("hello");
	});

	it("shouldSkipFusionVerify skips only after judge with empty unsupportedClaims (F2)", () => {
		const empty = { ...EMPTY_ANALYSIS };
		expect(shouldSkipFusionVerify(empty, true)).toBe(true);
		expect(shouldSkipFusionVerify({ ...empty, unsupportedClaims: ["claim"] }, true)).toBe(false);
		expect(shouldSkipFusionVerify(empty, false)).toBe(false);
	});

	it("buildWriterContext prepends prior conversation history before the task block", () => {
		// Minimal user/assistant turns; the writer only spreads them, so full AssistantMessage
		// fields (api/provider/usage/…) are irrelevant to this prepend-ordering check.
		const history = [
			{ role: "user", content: "earlier question", timestamp: 1 },
			{ role: "assistant", content: "earlier answer", timestamp: 2 },
		] as unknown as Message[];
		const ctx = buildWriterContext(
			"follow-up question",
			[{ member: { cli: "claude", model: "opus" }, ok: true, text: "panel answer" }],
			EMPTY_ANALYSIS,
			undefined,
			history,
		);
		expect(ctx.messages).toHaveLength(3);
		expect(ctx.messages[0]).toMatchObject({ role: "user", content: "earlier question" });
		expect(ctx.messages[1]).toMatchObject({ role: "assistant", content: "earlier answer" });
		const last = ctx.messages[2];
		const lastContent = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
		expect(lastContent).toContain("follow-up question");
	});
});
