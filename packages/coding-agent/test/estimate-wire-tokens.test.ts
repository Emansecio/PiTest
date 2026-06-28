import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import {
	estimateContextTokens,
	estimateToolSurfaceTokens,
	estimateWireTokens,
} from "../src/core/compaction/compaction.js";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantWithUsage(totalTokens: number): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		timestamp: 2,
		stopReason: "stop",
		usage: {
			input: totalTokens,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AgentMessage;
}

describe("estimateToolSurfaceTokens", () => {
	it("returns zero for an empty tool list", () => {
		expect(estimateToolSurfaceTokens([])).toBe(0);
	});

	it("counts name, description, and parameters as dense payload", () => {
		const tokens = estimateToolSurfaceTokens([
			{
				name: "read",
				description: "Read a file",
				parameters: { type: "object", properties: { path: { type: "string" } } },
			},
		]);
		expect(tokens).toBeGreaterThan(0);
	});
});

describe("estimateWireTokens", () => {
	it("adds system and tool surface to the message estimate", () => {
		const messages = [user("hi"), assistantWithUsage(500)];
		const messagesOnly = estimateContextTokens(messages).tokens;
		const wire = estimateWireTokens(messages, {
			systemPromptChars: 4000,
			tools: [
				{
					name: "read",
					description: "Read a file from disk",
					parameters: { type: "object", properties: { path: { type: "string" } } },
				},
			],
		});
		expect(wire.messageTokens).toBe(messagesOnly);
		expect(wire.systemTokens).toBeGreaterThan(0);
		expect(wire.toolTokens).toBeGreaterThan(0);
		expect(wire.tokens).toBeGreaterThan(messagesOnly);
		expect(wire.tokens).toBe(messagesOnly + wire.systemTokens + wire.toolTokens);
	});

	it("includes pending messages not yet in session state", () => {
		const messages = [user("hi"), assistantWithUsage(500)];
		const pending = [user("x".repeat(8000))];
		const without = estimateWireTokens(messages, { systemPromptChars: 0, tools: [] }).tokens;
		const withPending = estimateWireTokens(messages, {
			systemPromptChars: 0,
			tools: [],
			pendingMessages: pending,
		});
		expect(withPending.pendingTokens).toBeGreaterThan(1000);
		expect(withPending.tokens).toBeGreaterThan(without);
	});

	it("returns message-only total when prefix inputs are empty", () => {
		const messages = [user("short")];
		const wire = estimateWireTokens(messages, { systemPromptChars: 0, tools: [] });
		expect(wire.tokens).toBe(estimateContextTokens(messages).tokens);
	});
});
