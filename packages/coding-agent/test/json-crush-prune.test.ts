import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import { pruneOldToolOutputs } from "../src/core/compaction/compaction.js";

/** Build [toolResult(text), user, user] so the toolResult sits outside the protected recent turns. */
function messagesWithToolOutput(text: string): AgentMessage[] {
	return [
		{
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 1,
		},
		{ role: "user", content: [{ type: "text", text: "a" }], timestamp: 2 },
		{ role: "user", content: [{ type: "text", text: "b" }], timestamp: 3 },
	] as unknown as AgentMessage[];
}

function firstText(messages: AgentMessage[]): string {
	return (messages[0] as unknown as { content: { text: string }[] }).content[0].text;
}

describe("pruneOldToolOutputs + json-crush (phase 2)", () => {
	it("structurally crushes a large JSON tool output instead of a blind head/tail cut", () => {
		const bigJson = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ id: i, name: `n${i}`, status: "ok" })));
		const messages = messagesWithToolOutput(bigJson);

		const pruned = pruneOldToolOutputs(messages, 1000, 2);

		expect(pruned).toBeGreaterThan(0);
		const text = firstText(messages);
		expect(text).toContain("items elided"); // structural crush marker (not "tokens elided")
		expect(text).toContain('"status"'); // schema preserved
		expect(text).toContain("n0"); // head sample
		expect(text).toContain("n299"); // tail sample
		expect(text.length).toBeLessThan(bigJson.length);
	});

	it("falls back to head+tail for non-JSON output", () => {
		const bigText = `LINE_START ${"x".repeat(8000)} LINE_END`;
		const messages = messagesWithToolOutput(bigText);

		pruneOldToolOutputs(messages, 1000, 2);

		const text = firstText(messages);
		expect(text).toContain("tokens elided"); // headTailExcerpt marker
		expect(text).toContain("LINE_START"); // head preserved
		expect(text).toContain("LINE_END"); // tail preserved
	});
});
