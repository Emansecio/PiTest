import type { Message } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { serializeConversation, serializeConversationDelta } from "../src/core/compaction/utils.js";

function assistantToolCall(name: string, args: Record<string, unknown>): Message {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc1", name, arguments: args }],
		api: "anthropic",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

function toolResult(name: string, text: string): Message {
	return {
		role: "toolResult",
		toolCallId: "tc1",
		toolName: name,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

describe("serializeConversationDelta", () => {
	it("emits compact JSON with short keys", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "fix bug" }], timestamp: 1 },
			assistantToolCall("read", { path: "src/foo.ts" }),
			toolResult("read", "file contents"),
		];

		const raw = serializeConversationDelta(messages);
		const events = JSON.parse(raw) as Array<{ k: string }>;

		expect(events.map((e) => e.k)).toEqual(["u", "c", "r"]);
		expect(raw).not.toContain("[User]:");
		expect(raw).not.toContain("[Tool result]:");
	});

	it("omits thinking blocks that prose serialization keeps", () => {
		const thinking = "step\n".repeat(400);
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking },
					{ type: "text", text: "answer" },
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 1,
			},
		];

		const prose = serializeConversation(messages);
		const delta = serializeConversationDelta(messages);

		expect(prose).toContain("[Assistant thinking]:");
		expect(delta).not.toContain("thinking");
		expect(JSON.parse(delta)).toEqual([{ k: "a", t: "answer" }]);
	});

	it("is smaller than prose on edit-heavy tool args and results", () => {
		const oldBody = `export function old() {\n${"\treturn 1;\n".repeat(200)}}\n`;
		const newBody = `export function new() {\n${"\treturn 2;\n".repeat(200)}}\n`;
		const blob = `HEAD\n${"x".repeat(5000)}\nTAIL`;

		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "refactor module" }], timestamp: 1 },
			assistantToolCall("edit", { path: "src/mod.ts", oldText: oldBody, newText: newBody }),
			toolResult("edit", blob),
			assistantToolCall("read", { path: "src/mod.ts" }),
			toolResult("read", blob),
		];

		const prose = serializeConversation(messages);
		const delta = serializeConversationDelta(messages);

		expect(delta.length).toBeLessThan(prose.length);
		const parsed = JSON.parse(delta) as Array<{ k: string; a?: Record<string, unknown> }>;
		const editCall = parsed.find((e) => e.k === "c" && e.a?.path === "src/mod.ts");
		expect(editCall).toBeDefined();
		expect(String(editCall?.a?.oldText).length).toBeLessThanOrEqual(161);
	});
});
