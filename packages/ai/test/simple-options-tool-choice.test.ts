import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamSimpleAnthropic } from "../src/providers/anthropic.js";
import type { Context, Model, Tool } from "../src/types.js";

// SimpleStreamOptions.toolChoice → buildBaseOptions → AnthropicOptions.toolChoice
// → params.tool_choice. Cache-reusing side calls (summarization, fusion writer)
// rely on "none" to ship the full tools block (prefix identity) while forbidding
// tool calls — this pins the whole chain at the payload boundary.

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 64000,
	};
}

function makeContext(): Context {
	const tools: Tool[] = [
		{ name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
	];
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Summarize the conversation.", timestamp: 1 }],
		tools,
	};
}

async function capturePayload(toolChoice?: "auto" | "any" | "none"): Promise<Record<string, unknown>> {
	let captured: Record<string, unknown> | undefined;
	const result = await streamSimpleAnthropic(makeModel(), makeContext(), {
		apiKey: "test-key",
		...(toolChoice !== undefined ? { toolChoice } : {}),
		onPayload: (payload) => {
			captured = payload as Record<string, unknown>;
			// Short-circuit before any network request; the payload is already built.
			throw new Error("payload captured");
		},
	}).result();
	expect(result.stopReason).toBe("error");
	expect(captured).toBeDefined();
	return captured as Record<string, unknown>;
}

describe("SimpleStreamOptions.toolChoice reaches the Anthropic payload", () => {
	it('maps "none" to params.tool_choice {type:"none"} while keeping the tools block', async () => {
		const payload = await capturePayload("none");
		expect(payload.tool_choice).toEqual({ type: "none" });
		// The tools block still ships — that is the whole point for prefix identity.
		expect(Array.isArray(payload.tools)).toBe(true);
		expect((payload.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["read"]);
	});

	it("omits tool_choice when the option is not set (legacy requests unchanged)", async () => {
		const payload = await capturePayload(undefined);
		expect(payload.tool_choice).toBeUndefined();
		expect(Array.isArray(payload.tools)).toBe(true);
	});
});
