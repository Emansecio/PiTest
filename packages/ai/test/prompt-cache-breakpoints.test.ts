import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { buildParams as buildAnthropicParams } from "../src/providers/anthropic.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model } from "../src/types.js";
import { SYSTEM_PROMPT_DYNAMIC_MARKER } from "../src/types.js";

interface CacheControl {
	type: "ephemeral";
	ttl?: string;
}

interface TextPart {
	type: "text";
	text: string;
	cache_control?: CacheControl;
}

interface CapturedCompletionsParams {
	messages: Array<{ role: string; content: string | TextPart[] | null }>;
	tools?: Array<{ function?: { name: string }; cache_control?: CacheControl }>;
}

const STATIC_PART = "You are a helpful assistant with a very long static prefix.";
const DYNAMIC_PART = "Today is Monday. cwd: /tmp/project. Active todo: ship M1.";

function makeCompletionsModel(): Model<"openai-completions"> {
	return {
		id: "anthropic/claude-sonnet-4.5",
		name: "Claude via OpenRouter",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
		compat: { cacheControlFormat: "anthropic" },
	};
}

function makeTools() {
	// Deliberately unsorted: buildParams sorts tools by name before conversion.
	return [
		{ name: "gamma", description: "Tool gamma", parameters: Type.Object({ x: Type.String() }) },
		{ name: "alpha", description: "Tool alpha", parameters: Type.Object({ x: Type.String() }) },
		{ name: "beta", description: "Tool beta", parameters: Type.Object({ x: Type.String() }) },
	];
}

async function captureCompletionsPayload(
	model: Model<"openai-completions">,
	context: Context,
): Promise<CapturedCompletionsParams> {
	let captured: CapturedCompletionsParams | undefined;
	const result = await streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		onPayload: (payload) => {
			captured = payload as CapturedCompletionsParams;
			// Abort before any network request happens; the payload is already built.
			throw new Error("payload captured");
		},
	}).result();
	expect(result.stopReason).toBe("error");
	if (!captured) throw new Error("Expected payload to be captured");
	return captured;
}

describe("M2 - openai-completions anthropic cacheControlFormat splits system prompt on the dynamic marker", () => {
	it("emits the system prompt as two text parts with cache_control on the static part only", async () => {
		const context: Context = {
			systemPrompt: `${STATIC_PART}${SYSTEM_PROMPT_DYNAMIC_MARKER}${DYNAMIC_PART}`,
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			tools: makeTools(),
		};

		const params = await captureCompletionsPayload(makeCompletionsModel(), context);
		const system = params.messages.find((m) => m.role === "system" || m.role === "developer");
		expect(system).toBeDefined();
		const parts = system?.content as TextPart[];
		expect(Array.isArray(parts)).toBe(true);
		expect(parts).toHaveLength(2);
		expect(parts[0].text).toBe(STATIC_PART);
		expect(parts[0].cache_control).toEqual({ type: "ephemeral" });
		expect(parts[1].text).toBe(DYNAMIC_PART);
		expect(parts[1].cache_control).toBeUndefined();
		// The marker itself must never reach the wire.
		expect(JSON.stringify(params)).not.toContain("PIT_SYSTEM_PROMPT_DYNAMIC");
		// M1 must NOT also fire on this route: the last user message keeps its
		// original text (plus the last-message breakpoint), no <env> block.
		expect(JSON.stringify(params)).not.toContain("<env>");
	});

	it("keeps the single-part system prompt when there is no dynamic marker", async () => {
		const context: Context = {
			systemPrompt: STATIC_PART,
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const params = await captureCompletionsPayload(makeCompletionsModel(), context);
		const system = params.messages.find((m) => m.role === "system" || m.role === "developer");
		const parts = system?.content as TextPart[];
		expect(parts).toHaveLength(1);
		expect(parts[0].text).toBe(STATIC_PART);
		expect(parts[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("does not mutate the caller's context", async () => {
		const context: Context = {
			systemPrompt: `${STATIC_PART}${SYSTEM_PROMPT_DYNAMIC_MARKER}${DYNAMIC_PART}`,
			messages: [{ role: "user", content: "Hello", timestamp: 123 }],
			tools: makeTools(),
		};
		const snapshot = structuredClone(context);

		await captureCompletionsPayload(makeCompletionsModel(), context);
		expect(context).toEqual(snapshot);
	});
});

describe("M3 - cache breakpoint sits on the LAST tool", () => {
	it("openai-completions (anthropic format): only the last name-sorted tool carries cache_control", async () => {
		const context: Context = {
			systemPrompt: STATIC_PART,
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			tools: makeTools(),
		};

		const params = await captureCompletionsPayload(makeCompletionsModel(), context);
		expect(params.tools?.map((t) => t.function?.name)).toEqual(["alpha", "beta", "gamma"]);
		expect(params.tools?.[0].cache_control).toBeUndefined();
		expect(params.tools?.[1].cache_control).toBeUndefined();
		expect(params.tools?.[2].cache_control).toEqual({ type: "ephemeral" });
	});

	it("anthropic: only the last name-sorted tool carries cache_control", () => {
		const model: Model<"anthropic-messages"> = {
			id: "claude-sonnet-5",
			name: "Claude Sonnet",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		};
		const context: Context = {
			systemPrompt: `${STATIC_PART}${SYSTEM_PROMPT_DYNAMIC_MARKER}${DYNAMIC_PART}`,
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
			tools: makeTools(),
		};

		const params = buildAnthropicParams(model, context, false);
		const tools = params.tools as Array<{ name: string; cache_control?: CacheControl }>;
		expect(tools.map((t) => t.name)).toEqual(["alpha", "beta", "gamma"]);
		expect(tools[0].cache_control).toBeUndefined();
		expect(tools[1].cache_control).toBeUndefined();
		expect(tools[2].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });

		// Anthropic keeps its native split: static part pinned, dynamic unpinned,
		// and no <env> relocation on this route (byte-identical M1-wise).
		const system = params.system as Array<{ text: string; cache_control?: CacheControl }>;
		expect(system[0].text).toBe(STATIC_PART);
		expect(system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
		expect(system[1].text).toBe(DYNAMIC_PART);
		expect(system[1].cache_control).toBeUndefined();
		expect(JSON.stringify(params)).not.toContain("<env>");
	});
});
