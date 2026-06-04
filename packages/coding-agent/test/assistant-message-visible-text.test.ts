import { describe, expect, test } from "vitest";
import { messageHasVisibleText } from "../src/modes/interactive/components/assistant-message.js";

describe("messageHasVisibleText", () => {
	test("true when a non-empty text block exists", () => {
		expect(messageHasVisibleText({ content: [{ type: "text", text: "hello" }] } as any)).toBe(true);
	});

	test("false for thinking-only or whitespace text", () => {
		expect(messageHasVisibleText({ content: [{ type: "thinking", thinking: "x" }] } as any)).toBe(false);
		expect(messageHasVisibleText({ content: [{ type: "text", text: "   " }] } as any)).toBe(false);
	});

	test("false when only tool calls are present", () => {
		expect(messageHasVisibleText({ content: [{ type: "toolCall", id: "1", name: "read" }] } as any)).toBe(false);
	});
});
