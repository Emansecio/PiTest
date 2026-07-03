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

const WIRE_TOOLS = [
	{
		name: "read",
		description: "Read a file from disk",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
];

describe("estimateWireTokens", () => {
	it("adds system and tool surface when no provider usage anchors the estimate", () => {
		const messages = [user("hi"), user("there")];
		const estimate = estimateContextTokens(messages);
		expect(estimate.lastUsageIndex).toBeNull();
		const wire = estimateWireTokens(messages, {
			systemPromptChars: 4000,
			tools: WIRE_TOOLS,
		});
		expect(wire.messageTokens).toBe(estimate.tokens);
		expect(wire.systemTokens).toBeGreaterThan(0);
		expect(wire.toolTokens).toBeGreaterThan(0);
		expect(wire.tokens).toBeGreaterThan(estimate.tokens);
		expect(wire.tokens).toBe(estimate.tokens + wire.systemTokens + wire.toolTokens);
	});

	it("does NOT re-add system/tool tokens when anchored on provider usage (already billed there)", () => {
		const messages = [user("hi"), assistantWithUsage(500)];
		const estimate = estimateContextTokens(messages);
		expect(estimate.lastUsageIndex).not.toBeNull();
		const wire = estimateWireTokens(messages, {
			systemPromptChars: 4000,
			tools: WIRE_TOOLS,
		});
		// The prefix surface is still reported for inspection…
		expect(wire.systemTokens).toBeGreaterThan(0);
		expect(wire.toolTokens).toBeGreaterThan(0);
		// …but the total must not double-count it: the provider usage covers the
		// whole request (system prompt + tool schemas included).
		expect(wire.tokens).toBe(estimate.tokens);
	});

	it("still adds pending messages on top of a usage-anchored estimate", () => {
		const messages = [user("hi"), assistantWithUsage(500)];
		const estimate = estimateContextTokens(messages);
		const wire = estimateWireTokens(messages, {
			systemPromptChars: 4000,
			tools: WIRE_TOOLS,
			pendingMessages: [user("z".repeat(8000))],
		});
		expect(wire.pendingTokens).toBeGreaterThan(1000);
		expect(wire.tokens).toBe(estimate.tokens + wire.pendingTokens);
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
