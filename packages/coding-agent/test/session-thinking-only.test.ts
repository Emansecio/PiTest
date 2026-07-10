import { describe, expect, it } from "vitest";
import { sessionHasThinkingOnlyAssistant } from "../src/modes/interactive/interactive-mode.ts";

describe("sessionHasThinkingOnlyAssistant", () => {
	it("detects thinking-only assistant messages", () => {
		expect(
			sessionHasThinkingOnlyAssistant([
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: [{ type: "thinking", thinking: "hmm" }] },
			]),
		).toBe(true);
	});

	it("returns false when every assistant message has text", () => {
		expect(
			sessionHasThinkingOnlyAssistant([
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "hmm" },
						{ type: "text", text: "answer" },
					],
				},
			]),
		).toBe(false);
	});

	it("returns false for empty sessions", () => {
		expect(sessionHasThinkingOnlyAssistant([])).toBe(false);
	});
});
