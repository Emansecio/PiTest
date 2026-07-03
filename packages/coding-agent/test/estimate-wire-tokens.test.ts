import type { AgentMessage } from "@pit/agent-core";
import {
	CHARS_PER_TOKEN_DENSE,
	CHARS_PER_TOKEN_PROSE,
	inspectTokenEstimateCalibration,
	recordTokenEstimateSample,
	resetTokenEstimateCalibration,
} from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	estimateContextTokens,
	estimateTokens,
	estimateToolSurfaceTokens,
	estimateWireTokens,
} from "../src/core/compaction/compaction.js";

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as AgentMessage;
}

function assistantWithUsage(totalTokens: number, model?: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		timestamp: 2,
		stopReason: "stop",
		...(model ? { model, provider: "test", api: "test" } : {}),
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

// ============================================================================
// M7 — system prompt density classification
// ============================================================================

describe("estimateWireTokens system prompt density (M7)", () => {
	it("keeps the legacy prose /4 divisor when only the char count is known", () => {
		const wire = estimateWireTokens([user("hi")], { systemPromptChars: 4000, tools: [] });
		expect(wire.systemTokens).toBe(Math.ceil(4000 / CHARS_PER_TOKEN_PROSE));
	});

	it("classifies a dense system prompt (skills XML / schemas) with the dense divisor", () => {
		// XML-tag heavy prompt — structural symbols cross the density threshold.
		const densePrompt =
			'<skills>\n<skill name="a" path="/x/y.md"/>\n<skill name="b" path="/z/w.md"/>\n</skills>\n'.repeat(50);
		const wire = estimateWireTokens([user("hi")], {
			systemPromptChars: densePrompt.length,
			systemPromptText: densePrompt,
			tools: [],
		});
		expect(wire.systemTokens).toBe(Math.ceil(densePrompt.length / CHARS_PER_TOKEN_DENSE));
		expect(wire.systemTokens).toBeGreaterThan(Math.ceil(densePrompt.length / CHARS_PER_TOKEN_PROSE));
	});

	it("still classifies a prose system prompt as prose when the text is provided", () => {
		const prosePrompt = "You are a helpful coding assistant that answers in plain words. ".repeat(60);
		const wire = estimateWireTokens([user("hi")], {
			systemPromptChars: prosePrompt.length,
			systemPromptText: prosePrompt,
			tools: [],
		});
		expect(wire.systemTokens).toBe(Math.ceil(prosePrompt.length / CHARS_PER_TOKEN_PROSE));
	});
});

// ============================================================================
// M5 — online calibration wiring
// ============================================================================

describe("estimate calibration wiring (M5)", () => {
	afterEach(() => {
		resetTokenEstimateCalibration();
	});

	it("stays byte-identical to the uncalibrated estimate when no pairs were recorded (bench invariant)", () => {
		const messages = [user("hello there friend"), assistantWithUsage(500, "model-x"), user("trailing text")];
		const estimate = estimateContextTokens(messages);
		const rawTrailing = estimateTokens(messages[2]);
		expect(estimate.trailingTokens).toBe(rawTrailing);
		expect(estimate.tokens).toBe(500 + rawTrailing);
	});

	it("records a (span estimate, usage) pair once per anchor when the span is large enough", () => {
		// Big prose message so the span estimate crosses the 5k-token floor.
		const big = user("w".repeat(40_000));
		const messages = [big, assistantWithUsage(20_000, "model-cal-a")];
		estimateWireTokens(messages, { systemPromptChars: 0, tools: [] });
		const one = inspectTokenEstimateCalibration().byModel["model-cal-a"];
		expect(one?.samples).toBe(1);
		// Same anchor object re-estimated -> no duplicate sample (WeakSet dedupe).
		estimateWireTokens(messages, { systemPromptChars: 0, tools: [] });
		expect(inspectTokenEstimateCalibration().byModel["model-cal-a"]?.samples).toBe(1);
	});

	it("multiplies ONLY the char-based trailing portion by the learned factor — never the usage anchor", () => {
		// Learn a 2x factor for the model.
		recordTokenEstimateSample("model-cal-b", 10_000, 20_000);
		const trailing = user("t".repeat(4_000)); // 1000 raw prose tokens
		const messages = [user("hi"), assistantWithUsage(500, "model-cal-b"), trailing];
		const estimate = estimateContextTokens(messages);
		const rawTrailing = estimateTokens(trailing);
		expect(estimate.usageTokens).toBe(500); // anchor untouched
		expect(estimate.trailingTokens).toBe(Math.round(rawTrailing * 2));
		expect(estimate.tokens).toBe(500 + Math.round(rawTrailing * 2));
	});

	it("corrects fully unanchored estimates with the global factor", () => {
		recordTokenEstimateSample("model-cal-c", 10_000, 15_000); // global seeds at 1.5
		const messages = [user("u".repeat(8_000))];
		const estimate = estimateContextTokens(messages);
		const raw = estimateTokens(messages[0]);
		expect(estimate.tokens).toBe(Math.round(raw * 1.5));
	});
});
