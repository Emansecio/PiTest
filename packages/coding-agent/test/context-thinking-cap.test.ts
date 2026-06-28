import type { AgentMessage } from "@pit/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { applyOldThinkingCap, wouldApplyOldThinkingCap } from "../src/core/compaction/compaction.js";
import { capThinkingForContext, THINKING_MAX_CHARS } from "../src/core/compaction/utils.js";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantThinking(thinking: string, text = "done"): AgentMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking },
			{ type: "text", text },
		],
		timestamp: 1,
		stopReason: "stop",
	} as AgentMessage;
}

function thinkingAt(messages: AgentMessage[], i: number): string {
	const msg = messages[i] as { content: { type: string; thinking?: string }[] };
	const block = msg.content.find((b) => b.type === "thinking");
	return block?.thinking ?? "";
}

describe("capThinkingForContext", () => {
	it("returns short thinking unchanged", () => {
		const short = "brief reasoning";
		expect(capThinkingForContext(short)).toBe(short);
	});

	it("caps long thinking to THINKING_MAX_CHARS head+tail shape", () => {
		const long = `HEAD_DECISION\n${"middle line\n".repeat(500)}TAIL_DECISION`;
		const capped = capThinkingForContext(long);
		expect(capped.length).toBeLessThanOrEqual(THINKING_MAX_CHARS + 80);
		expect(capped).toContain("truncated");
		expect(capped).toContain("HEAD_DECISION");
		expect(capped).toContain("TAIL_DECISION");
	});
});

describe("applyOldThinkingCap (A4)", () => {
	afterEach(() => {
		delete process.env.PIT_NO_THINKING_CAP;
	});

	it("caps thinking older than protectTurns but keeps recent turns", () => {
		const oldThinking = "old reasoning\n".repeat(600);
		const recentThinking = "recent reasoning\n".repeat(600);
		const messages = [
			user("problem 1"),
			assistantThinking(oldThinking, "answer 1"),
			user("problem 2"),
			assistantThinking(recentThinking, "answer 2"),
			user("final"),
		];

		expect(wouldApplyOldThinkingCap(messages, 2)).toBe(true);
		const reclaimed = applyOldThinkingCap(messages, 2);
		expect(reclaimed).toBeGreaterThan(1000);
		expect(thinkingAt(messages, 1).length).toBeLessThan(oldThinking.length);
		expect(thinkingAt(messages, 3)).toBe(recentThinking);
	});

	it("no-ops when all thinking is within protect window", () => {
		const thinking = "x".repeat(8000);
		const messages = [user("only"), assistantThinking(thinking)];
		expect(wouldApplyOldThinkingCap(messages, 1)).toBe(false);
		expect(applyOldThinkingCap(messages, 1)).toBe(0);
	});
});
