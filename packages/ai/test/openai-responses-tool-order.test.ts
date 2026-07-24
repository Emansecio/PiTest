import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import { convertResponsesTools } from "../src/providers/openai-responses-shared.js";
import type { Context, Model, Tool } from "../src/types.js";
import { buildToolNameGuard } from "../src/utils/tool-name-guard.js";

// Deliberately unsorted: convertResponsesTools sorts tools by name before
// serialization so the OpenAI implicit prefix cache is not invalidated by the
// caller's (activation-order) tool order.
function makeTools(): Tool[] {
	return [
		{ name: "gamma", description: "Tool gamma", parameters: Type.Object({ x: Type.String() }) },
		{ name: "alpha", description: "Tool alpha", parameters: Type.Object({ x: Type.String() }) },
		{ name: "beta", description: "Tool beta", parameters: Type.Object({ x: Type.String() }) },
	];
}

function makeResponsesModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5.1",
		name: "GPT-5.1",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

function makeCodexModel(): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.1-codex",
		name: "GPT-5.1 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

// Codex extracts the account id from the JWT before building/serializing the body,
// so the token must carry a decodable auth claim.
function mockCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

function makeContext(tools: Tool[]): Context {
	return {
		systemPrompt: "You are a helpful assistant.",
		messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		tools,
	};
}

describe("convertResponsesTools emits tools in canonical name-sorted order", () => {
	it("sorts by tool name regardless of input order", () => {
		const wire = convertResponsesTools(makeTools());
		// OpenAITool is a union; function tools carry `name`.
		expect(wire.map((t) => (t as { name: string }).name)).toEqual(["alpha", "beta", "gamma"]);
	});

	it("preserves the name-keyed guard remap while reordering the output", () => {
		// Two out-of-charset names force an active (non-noop) guard. Sorting is by the
		// ORIGINAL name; each tool must still carry its own wire-safe name.
		const tools: Tool[] = [
			{ name: "z:weird/tool", description: "z", parameters: Type.Object({ x: Type.String() }) },
			{ name: "a:weird/tool", description: "a", parameters: Type.Object({ x: Type.String() }) },
		];
		const guard = buildToolNameGuard(tools);
		expect(guard.active).toBe(true);
		const wire = convertResponsesTools(tools, undefined, guard);
		// Sorted by original name ("a…" before "z…"), each mapped to its own wire name.
		expect(wire.map((t) => (t as { name: string }).name)).toEqual(["a_weird_tool", "z_weird_tool"]);
	});

	it("does not mutate the caller's tools array", () => {
		const tools = makeTools();
		const snapshot = tools.map((t) => t.name);
		convertResponsesTools(tools);
		expect(tools.map((t) => t.name)).toEqual(snapshot);
	});
});

describe("openai-responses route serializes tools name-sorted", () => {
	it("params.tools come out alphabetized by name", async () => {
		let captured: { tools?: Array<{ name: string }> } | undefined;
		const result = await streamOpenAIResponses(makeResponsesModel(), makeContext(makeTools()), {
			apiKey: "test-key",
			onPayload: (payload) => {
				captured = payload as { tools?: Array<{ name: string }> };
				// Short-circuit before any network request; the payload is already built.
				throw new Error("payload captured");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(captured?.tools?.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
	});
});

describe("openai-codex-responses route serializes tools name-sorted", () => {
	it("body.tools come out alphabetized by name", async () => {
		let captured: { tools?: Array<{ name: string }> } | undefined;
		const result = await streamOpenAICodexResponses(makeCodexModel(), makeContext(makeTools()), {
			apiKey: mockCodexToken(),
			transport: "sse",
			onPayload: (payload) => {
				captured = payload as { tools?: Array<{ name: string }> };
				throw new Error("payload captured");
			},
		}).result();
		expect(result.stopReason).toBe("error");
		expect(captured?.tools?.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
	});
});
