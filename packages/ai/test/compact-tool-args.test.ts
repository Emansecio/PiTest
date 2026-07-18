import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeToolArgs } from "../src/providers/openai-responses-shared.js";
import { streamSimple } from "../src/stream.js";
import type { AssistantMessage, Model, ToolCall } from "../src/types.js";
import { openaiCompletionsModel } from "./helpers/pruned-fixtures.js";

function toolCall(args: unknown): ToolCall {
	return { type: "toolCall", id: "call_1", name: "read", arguments: args as ToolCall["arguments"] };
}

describe("serializeToolArgs — compact tool arguments", () => {
	afterEach(() => {
		delete process.env.PIT_NO_COMPACT_ARGS;
	});

	it("keeps object arguments compact (the common case)", () => {
		expect(serializeToolArgs(toolCall({ path: "README.md", n: 1 }))).toBe('{"path":"README.md","n":1}');
	});

	it("re-serializes a pretty-printed JSON string argument as compact", () => {
		const pretty = '{\n  "path": "README.md",\n  "n": 1\n}';
		expect(serializeToolArgs(toolCall(pretty))).toBe('{"path":"README.md","n":1}');
	});

	it("passes a malformed string argument through untouched", () => {
		const malformed = '{"path": "README.md"'; // missing closing brace
		expect(serializeToolArgs(toolCall(malformed))).toBe(malformed);
	});

	it("does not compact string arguments when PIT_NO_COMPACT_ARGS is set", () => {
		process.env.PIT_NO_COMPACT_ARGS = "1";
		const pretty = '{\n  "path": "README.md"\n}';
		// Falls back to plain JSON.stringify of the string (double-encoded), not compacted.
		expect(serializeToolArgs(toolCall(pretty))).toBe(JSON.stringify(pretty));
	});
});

const mockState = vi.hoisted(() => ({ lastParams: undefined as any }));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								choices: [{ delta: {}, finish_reason: "stop" }],
								usage: {
									prompt_tokens: 1,
									completion_tokens: 1,
									prompt_tokens_details: { cached_tokens: 0 },
									completion_tokens_details: { reasoning_tokens: 0 },
								},
							};
						},
					};
					const promise = Promise.resolve(stream) as any;
					promise.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

describe("compact tool arguments on the wire", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
	});

	it("emits a pretty-printed historical argument as compact JSON on the wire", async () => {
		const { compat: _compat, ...baseModel } = openaiCompletionsModel()!;
		const model = { ...baseModel, api: "openai-completions" } as Model<"openai-completions">;
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: model.id,
			content: [
				{
					type: "toolCall",
					id: "call_1",
					name: "read",
					// A tool call replayed from a persisted transcript may carry a
					// pretty-printed JSON string here rather than a parsed object.
					arguments: '{\n  "path": "README.md"\n}' as unknown as ToolCall["arguments"],
				},
			],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: Date.now(),
		};

		await streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: "read it", timestamp: Date.now() },
					assistant,
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "read",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "thanks", timestamp: Date.now() },
				],
			},
			{ apiKey: "test" },
		).result();

		const replayed = mockState.lastParams.messages.find((m: any) => m.role === "assistant");
		expect(replayed.tool_calls[0].function.arguments).toBe('{"path":"README.md"}');
	});
});
