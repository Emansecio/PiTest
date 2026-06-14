import { describe, expect, it } from "vitest";
import { buildJudgeContext, JUDGE_SCHEMA, parseJudgeOutput } from "../../src/core/fusion/judge.ts";

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
		});
		const parsed = parseJudgeOutput(`\`\`\`json\n${json}\n\`\`\``);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) expect(parsed.value.uniqueInsights).toEqual(["y"]);
		// keep JUDGE_SCHEMA referenced as a public export
		expect(JUDGE_SCHEMA.type).toBe("object");
	});

	it("rejects malformed judge output", () => {
		expect(parseJudgeOutput("garbage").ok).toBe(false);
		expect(parseJudgeOutput('```json\n{"consensus":"notarray"}\n```').ok).toBe(false);
	});
});
