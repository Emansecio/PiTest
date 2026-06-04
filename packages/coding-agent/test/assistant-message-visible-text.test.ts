import { describe, expect, test } from "vitest";
import { messageHasVisibleContent } from "../src/modes/interactive/components/assistant-message.js";

describe("messageHasVisibleContent", () => {
	test("non-empty text is always visible", () => {
		expect(messageHasVisibleContent({ content: [{ type: "text", text: "hello" }] } as any, false)).toBe(true);
		expect(messageHasVisibleContent({ content: [{ type: "text", text: "hello" }] } as any, true)).toBe(true);
	});

	test("thinking counts only when includeThinking is true", () => {
		const msg = { content: [{ type: "thinking", thinking: "x" }] } as any;
		expect(messageHasVisibleContent(msg, false)).toBe(false);
		expect(messageHasVisibleContent(msg, true)).toBe(true);
	});

	test("whitespace text and tool-only blocks are not visible", () => {
		expect(messageHasVisibleContent({ content: [{ type: "text", text: "   " }] } as any, true)).toBe(false);
		expect(messageHasVisibleContent({ content: [{ type: "toolCall", id: "1" }] } as any, true)).toBe(false);
	});
});
