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

	it("keeps a window that starts with tool calls (no leading user) — never empties it", () => {
		// Regression: a compacted window whose first parts are tool calls before any
		// user message used to serialize to `[]` (total data loss). The surviving
		// read (the last of the resource) must remain.
		const messages: Message[] = [
			assistantToolCall("read", { path: "src/foo.ts" }),
			toolResult("read", "OLD"),
			assistantToolCall("read", { path: "src/foo.ts" }),
			toolResult("read", "NEW"),
		];
		const events = JSON.parse(serializeConversationDelta(messages)) as Array<{ k: string; t?: string }>;
		expect(events.length).toBeGreaterThan(0);
		expect(events.map((e) => e.k)).toEqual(["c", "r"]);
		expect(events.filter((e) => e.k === "r").map((e) => e.t)).toEqual(["NEW"]);
	});

	it("preserves a leading tool call that precedes the first user message", () => {
		// Regression: with dedup keys assigned before the first user message, the
		// leading read + result were dropped entirely. Both segments must survive.
		const messages: Message[] = [
			assistantToolCall("read", { path: "src/lead.ts" }),
			toolResult("read", "LEAD"),
			{ role: "user", content: [{ type: "text", text: "now do X" }], timestamp: 1 },
			assistantToolCall("read", { path: "src/after.ts" }),
			toolResult("read", "AFTER"),
		];
		const events = JSON.parse(serializeConversationDelta(messages)) as Array<{ k: string; t?: string }>;
		expect(events.map((e) => e.k)).toEqual(["c", "r", "u", "c", "r"]);
		expect(events.filter((e) => e.k === "r").map((e) => e.t)).toEqual(["LEAD", "AFTER"]);
	});

	it("dedups repeated reads of the same file within a chain to the last", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "inspect foo" }], timestamp: 1 },
			assistantToolCall("read", { path: "src/foo.ts" }),
			toolResult("read", "A"),
			assistantToolCall("read", { path: "src/foo.ts" }),
			toolResult("read", "B"),
			assistantToolCall("read", { path: "src/foo.ts" }),
			toolResult("read", "C"),
		];
		const events = JSON.parse(serializeConversationDelta(messages)) as Array<{ k: string; t?: string }>;
		expect(events.map((e) => e.k)).toEqual(["u", "c", "r"]);
		expect(events.filter((e) => e.k === "r").map((e) => e.t)).toEqual(["C"]);
	});

	it("does NOT dedup same-file reads separated by a user message (chain breaker)", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "text", text: "read it" }], timestamp: 1 },
			assistantToolCall("read", { path: "src/foo.ts" }),
			toolResult("read", "A"),
			{ role: "user", content: [{ type: "text", text: "read it again" }], timestamp: 1 },
			assistantToolCall("read", { path: "src/foo.ts" }),
			toolResult("read", "B"),
		];
		const events = JSON.parse(serializeConversationDelta(messages)) as Array<{ k: string; t?: string }>;
		expect(events.map((e) => e.k)).toEqual(["u", "c", "r", "u", "c", "r"]);
		expect(events.filter((e) => e.k === "r").map((e) => e.t)).toEqual(["A", "B"]);
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
