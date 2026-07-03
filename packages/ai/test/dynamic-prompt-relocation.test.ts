import { describe, expect, it } from "vitest";
import { buildParams as buildGoogleParams } from "../src/providers/google.js";
import { streamOpenAICodexResponses } from "../src/providers/openai-codex-responses.js";
import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { AssistantMessage, Context, Model } from "../src/types.js";
import { SYSTEM_PROMPT_DYNAMIC_MARKER } from "../src/types.js";

const STATIC_PART = "You are a helpful assistant with a very long static prefix.";
const DYNAMIC_PART = "Today is Monday. cwd: /tmp/project. Active todo: ship M1.";
const ENV_BLOCK = `<env>\n${DYNAMIC_PART}\n</env>`;
const MARKED_PROMPT = `${STATIC_PART}${SYSTEM_PROMPT_DYNAMIC_MARKER}${DYNAMIC_PART}`;

function makeAssistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Previous reply" }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.2",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

function mockCodexToken(): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc_test" } }),
		"utf8",
	).toString("base64");
	return `aaa.${payload}.bbb`;
}

// Capture the built provider payload via onPayload, then abort before any
// network request happens.
async function capturePayload<T>(
	stream: (onPayload: (payload: unknown) => never) => { result: () => Promise<AssistantMessage> },
): Promise<T> {
	let captured: T | undefined;
	const result = await stream((payload) => {
		captured = payload as T;
		throw new Error("payload captured");
	}).result();
	expect(result.stopReason).toBe("error");
	if (captured === undefined) throw new Error("Expected payload to be captured");
	return captured;
}

// ============================================================================
// openai-responses
// ============================================================================

interface ResponsesInputItem {
	role?: string;
	type?: string;
	content?: string | Array<{ type: string; text?: string }>;
}

interface CapturedResponsesParams {
	input: ResponsesInputItem[];
	instructions?: string;
}

function makeResponsesModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5.2",
		name: "GPT-5.2",
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

async function captureResponsesPayload(context: Context): Promise<CapturedResponsesParams> {
	return capturePayload<CapturedResponsesParams>((onPayload) =>
		streamOpenAIResponses(makeResponsesModel(), context, { apiKey: "test-key", onPayload }),
	);
}

describe("M1 — openai-responses dynamic prompt relocation", () => {
	it("keeps only the static part in the system message and prepends <env> to the last user message", async () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [
				{ role: "user", content: "First question", timestamp: 1 },
				makeAssistantMessage({}),
				{ role: "user", content: "Second question", timestamp: 2 },
			],
		};

		const params = await captureResponsesPayload(context);
		const system = params.input[0];
		expect(system.role).toBe("developer");
		expect(system.content).toBe(STATIC_PART);

		const userItems = params.input.filter((item) => item.role === "user");
		expect(userItems).toHaveLength(2);
		// Only the MOST RECENT user message carries the env block, as its first part.
		const firstUser = userItems[0].content as Array<{ type: string; text?: string }>;
		expect(firstUser).toHaveLength(1);
		expect(firstUser[0].text).toBe("First question");
		const lastUser = userItems[1].content as Array<{ type: string; text?: string }>;
		expect(lastUser).toHaveLength(2);
		expect(lastUser[0]).toEqual({ type: "input_text", text: ENV_BLOCK });
		expect(lastUser[1].text).toBe("Second question");

		expect(JSON.stringify(params)).not.toContain("PIT_SYSTEM_PROMPT_DYNAMIC");
	});

	it("is a no-op when the system prompt has no dynamic marker", async () => {
		const context: Context = {
			systemPrompt: STATIC_PART,
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};

		const params = await captureResponsesPayload(context);
		expect(params.input[0].content).toBe(STATIC_PART);
		expect(JSON.stringify(params)).not.toContain("<env>");
	});

	it("falls back to the full stripped system prompt when the payload has no user message", async () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [makeAssistantMessage({})],
		};

		const params = await captureResponsesPayload(context);
		expect(params.input[0].role).toBe("developer");
		expect(params.input[0].content).toBe(`${STATIC_PART}${DYNAMIC_PART}`);
		expect(JSON.stringify(params)).not.toContain("<env>");
		expect(JSON.stringify(params)).not.toContain("PIT_SYSTEM_PROMPT_DYNAMIC");
	});

	it("does not mutate the caller's context", async () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: "Array-content question" }], timestamp: 1 }],
		};
		const snapshot = structuredClone(context);

		await captureResponsesPayload(context);
		expect(context).toEqual(snapshot);
	});
});

// ============================================================================
// openai-codex-responses
// ============================================================================

describe("M1 — openai-codex-responses dynamic prompt relocation", () => {
	it("keeps instructions static and prepends <env> to the last user input item", async () => {
		const model: Model<"openai-codex-responses"> = {
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
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [{ role: "user", content: "Say hello", timestamp: 1 }],
		};
		const snapshot = structuredClone(context);

		const body = await capturePayload<CapturedResponsesParams>((onPayload) =>
			streamOpenAICodexResponses(model, context, { apiKey: mockCodexToken(), onPayload }),
		);

		expect(body.instructions).toBe(STATIC_PART);
		const userItems = body.input.filter((item) => item.role === "user");
		expect(userItems).toHaveLength(1);
		const content = userItems[0].content as Array<{ type: string; text?: string }>;
		expect(content[0]).toEqual({ type: "input_text", text: ENV_BLOCK });
		expect(content[1].text).toBe("Say hello");
		expect(JSON.stringify(body)).not.toContain("PIT_SYSTEM_PROMPT_DYNAMIC");
		expect(context).toEqual(snapshot);
	});
});

// ============================================================================
// google
// ============================================================================

function makeGoogleModel(): Model<"google-generative-ai"> {
	return {
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 8192,
	};
}

interface GooglePart {
	text?: string;
	functionCall?: unknown;
	functionResponse?: unknown;
}

describe("M1 — google dynamic prompt relocation", () => {
	it("keeps only the static part in systemInstruction and prepends <env> to the last user turn", () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};
		const snapshot = structuredClone(context);

		const params = buildGoogleParams(makeGoogleModel(), context);
		expect(params.config?.systemInstruction).toBe(STATIC_PART);

		const contents = params.contents as Array<{ role: string; parts: GooglePart[] }>;
		expect(contents[0].parts[0].text).toBe(ENV_BLOCK);
		expect(contents[0].parts[1].text).toBe("Hello");
		expect(JSON.stringify(params)).not.toContain("PIT_SYSTEM_PROMPT_DYNAMIC");
		expect(context).toEqual(snapshot);
	});

	it("targets the last REAL user turn, not a trailing function-response turn", () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [
				{ role: "user", content: "Run the tool", timestamp: 1 },
				makeAssistantMessage({
					api: "google-generative-ai",
					provider: "google",
					model: "gemini-2.5-flash",
					content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }],
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const params = buildGoogleParams(makeGoogleModel(), context);
		expect(params.config?.systemInstruction).toBe(STATIC_PART);

		const contents = params.contents as Array<{ role: string; parts: GooglePart[] }>;
		// [user, model(functionCall), user(functionResponse)]
		expect(contents).toHaveLength(3);
		expect(contents[0].parts[0].text).toBe(ENV_BLOCK);
		expect(contents[0].parts[1].text).toBe("Run the tool");
		// The wire-level "user" turn carrying the function response stays untouched.
		expect(contents[2].role).toBe("user");
		expect(contents[2].parts.some((p) => p.functionResponse)).toBe(true);
		expect(contents[2].parts.some((p) => typeof p.text === "string" && p.text.includes("<env>"))).toBe(false);
	});

	it("is a no-op when the system prompt has no dynamic marker", () => {
		const context: Context = {
			systemPrompt: STATIC_PART,
			messages: [{ role: "user", content: "Hello", timestamp: 1 }],
		};

		const params = buildGoogleParams(makeGoogleModel(), context);
		expect(params.config?.systemInstruction).toBe(STATIC_PART);
		expect(JSON.stringify(params)).not.toContain("<env>");
	});

	it("falls back to the full stripped prompt when there is no real user turn", () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [
				makeAssistantMessage({
					api: "google-generative-ai",
					provider: "google",
					model: "gemini-2.5-flash",
				}),
			],
		};

		const params = buildGoogleParams(makeGoogleModel(), context);
		expect(params.config?.systemInstruction).toBe(`${STATIC_PART}${DYNAMIC_PART}`);
		expect(JSON.stringify(params)).not.toContain("<env>");
	});
});

// ============================================================================
// openai-completions (pure OpenAI-format route, no anthropic cache_control)
// ============================================================================

interface CapturedCompletionsParams {
	messages: Array<{
		role: string;
		content: string | Array<{ type: string; text?: string }> | null;
	}>;
}

function makeCompletionsModel(): Model<"openai-completions"> {
	return {
		id: "gpt-5.2-chat",
		name: "GPT-5.2 Chat",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	};
}

async function captureCompletionsPayload(context: Context): Promise<CapturedCompletionsParams> {
	return capturePayload<CapturedCompletionsParams>((onPayload) =>
		streamOpenAICompletions(makeCompletionsModel(), context, { apiKey: "test-key", onPayload }),
	);
}

describe("M1 — openai-completions (automatic prefix cache route) dynamic prompt relocation", () => {
	it("keeps only the static part in the system message and prefixes the last user string content", async () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [
				{ role: "user", content: "First question", timestamp: 1 },
				makeAssistantMessage({ api: "openai-completions", provider: "openai", model: "gpt-5.2-chat" }),
				{ role: "user", content: "Second question", timestamp: 2 },
			],
		};
		const snapshot = structuredClone(context);

		const params = await captureCompletionsPayload(context);
		expect(params.messages[0].role).toBe("system");
		expect(params.messages[0].content).toBe(STATIC_PART);

		const userMessages = params.messages.filter((m) => m.role === "user");
		expect(userMessages[0].content).toBe("First question");
		// String content stays a plain string for maximum server compatibility.
		expect(userMessages[1].content).toBe(`${ENV_BLOCK}\n\nSecond question`);
		expect(JSON.stringify(params)).not.toContain("PIT_SYSTEM_PROMPT_DYNAMIC");
		expect(context).toEqual(snapshot);
	});

	it("prepends a text part when the last user message has array content", async () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: "Array question" }], timestamp: 1 }],
		};

		const params = await captureCompletionsPayload(context);
		const user = params.messages.find((m) => m.role === "user");
		const content = user?.content as Array<{ type: string; text?: string }>;
		expect(content[0]).toEqual({ type: "text", text: ENV_BLOCK });
		expect(content[1].text).toBe("Array question");
	});

	it("targets the last real user message, not a trailing tool result", async () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [
				{ role: "user", content: "Run the tool", timestamp: 1 },
				makeAssistantMessage({
					api: "openai-completions",
					provider: "openai",
					model: "gpt-5.2-chat",
					content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }],
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					isError: false,
					timestamp: 2,
				},
			],
		};

		const params = await captureCompletionsPayload(context);
		const roles = params.messages.map((m) => m.role);
		expect(roles).toEqual(["system", "user", "assistant", "tool"]);
		expect(params.messages[1].content).toBe(`${ENV_BLOCK}\n\nRun the tool`);
		const tool = params.messages[3];
		expect(tool.content).toBe("file contents");
	});

	it("falls back to the full stripped system prompt when the payload has no user message", async () => {
		const context: Context = {
			systemPrompt: MARKED_PROMPT,
			messages: [makeAssistantMessage({ api: "openai-completions", provider: "openai", model: "gpt-5.2-chat" })],
		};

		const params = await captureCompletionsPayload(context);
		expect(params.messages[0].content).toBe(`${STATIC_PART}${DYNAMIC_PART}`);
		expect(JSON.stringify(params)).not.toContain("<env>");
	});
});
