import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { AssistantMessage, Model, Tool } from "../src/types.js";
import { buildToolNameGuard, NOOP_TOOL_NAME_GUARD } from "../src/utils/tool-name-guard.js";
import { openaiCompletionsModel } from "./helpers/pruned-fixtures.js";

function tool(name: string): Tool {
	return { name, description: `tool ${name}`, parameters: Type.Object({ ok: Type.Boolean() }) };
}

describe("buildToolNameGuard", () => {
	it("is a no-op (identity, inactive) when every name is already valid", () => {
		const guard = buildToolNameGuard([tool("read"), tool("write_file"), tool("Glob-2")]);
		expect(guard.active).toBe(false);
		expect(guard).toBe(NOOP_TOOL_NAME_GUARD);
		expect(guard.toWire("read")).toBe("read");
		expect(guard.fromWire("read")).toBe("read");
	});

	it("is a no-op for empty / undefined tool sets", () => {
		expect(buildToolNameGuard(undefined)).toBe(NOOP_TOOL_NAME_GUARD);
		expect(buildToolNameGuard([])).toBe(NOOP_TOOL_NAME_GUARD);
	});

	it("sanitizes chars outside [a-zA-Z0-9_-] to _ and round-trips", () => {
		const guard = buildToolNameGuard([tool("my:weird/tool.name")]);
		expect(guard.active).toBe(true);
		expect(guard.toWire("my:weird/tool.name")).toBe("my_weird_tool_name");
		expect(guard.fromWire("my_weird_tool_name")).toBe("my:weird/tool.name");
	});

	it("truncates a name longer than 64 chars", () => {
		const longName = `x${"a".repeat(70)}!`; // invalid char forces the guard on
		const guard = buildToolNameGuard([tool(longName)]);
		const wire = guard.toWire(longName);
		expect(wire.length).toBe(64);
		expect(guard.fromWire(wire)).toBe(longName);
	});

	it("dedupes deterministically when two distinct names collide", () => {
		const a = "dup:name";
		const b = "dup/name"; // both sanitize to dup_name
		const guard = buildToolNameGuard([tool(a), tool(b)]);
		expect(guard.toWire(a)).toBe("dup_name");
		expect(guard.toWire(b)).toBe("dup_name_2");
		// Reverse map is unambiguous.
		expect(guard.fromWire("dup_name")).toBe(a);
		expect(guard.fromWire("dup_name_2")).toBe(b);
		// Stable across rebuilds with the same input order.
		const guard2 = buildToolNameGuard([tool(a), tool(b)]);
		expect(guard2.toWire(a)).toBe("dup_name");
		expect(guard2.toWire(b)).toBe("dup_name_2");
	});

	it("keeps the deduped suffix within the 64-char limit", () => {
		const base = "z".repeat(63);
		const a = `${base}:`; // sanitizes to z*63 + _  => 64 chars
		const b = `${base}/`; // collides
		const guard = buildToolNameGuard([tool(a), tool(b)]);
		const wireA = guard.toWire(a);
		const wireB = guard.toWire(b);
		expect(wireA.length).toBeLessThanOrEqual(64);
		expect(wireB.length).toBeLessThanOrEqual(64);
		expect(wireB.endsWith("_2")).toBe(true);
		expect(guard.fromWire(wireB)).toBe(b);
	});

	it("toWireHistorical sanitizes an invalid historical name absent from the current tool set (active guard)", () => {
		// Guard is active because a CURRENT tool has an invalid name.
		const guard = buildToolNameGuard([tool("cur:tool")]);
		expect(guard.active).toBe(true);
		// A name from a since-removed tool / disconnected MCP is not in the map:
		// it must still be sanitized rather than passed raw (would poison the wire).
		expect(guard.toWireHistorical("old:removed/tool")).toBe("old_removed_tool");
		// Current-tool-set names still resolve to their assigned wire name.
		expect(guard.toWireHistorical("cur:tool")).toBe("cur_tool");
		// A VALID historical name that misses the map is left intact.
		expect(guard.toWireHistorical("valid_name")).toBe("valid_name");
	});

	it("toWireHistorical sanitizes invalid history even when the guard is the no-op", () => {
		// Every current tool is valid -> the shared no-op guard.
		const guard = buildToolNameGuard([tool("read"), tool("write_file")]);
		expect(guard).toBe(NOOP_TOOL_NAME_GUARD);
		expect(guard.active).toBe(false);
		// Invalid historical name still gets sanitized (else it poisons the wire).
		expect(guard.toWireHistorical("mcp:server.tool")).toBe("mcp_server_tool");
		// Valid historical name passes through unchanged (allocation-free path).
		expect(guard.toWireHistorical("read")).toBe("read");
	});

	it("toWireHistorical truncates an over-long historical name to 64 chars", () => {
		const longName = "a".repeat(80); // valid charset but over the 64-char limit
		expect(NOOP_TOOL_NAME_GUARD.toWireHistorical(longName).length).toBe(64);
	});

	it("returns the no-op guard when PIT_NO_TOOLNAME_GUARD is set", () => {
		const prev = process.env.PIT_NO_TOOLNAME_GUARD;
		process.env.PIT_NO_TOOLNAME_GUARD = "1";
		try {
			const guard = buildToolNameGuard([tool("my:weird/tool")]);
			expect(guard).toBe(NOOP_TOOL_NAME_GUARD);
			expect(guard.active).toBe(false);
			expect(guard.toWire("my:weird/tool")).toBe("my:weird/tool");
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_TOOLNAME_GUARD;
			else process.env.PIT_NO_TOOLNAME_GUARD = prev;
		}
	});
});

const mockState = vi.hoisted(() => ({
	lastParams: undefined as any,
	chunks: undefined as any,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					mockState.lastParams = params;
					const stream = {
						async *[Symbol.asyncIterator]() {
							const chunks = mockState.chunks ?? [];
							for (const chunk of chunks) yield chunk;
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

describe("tool-name guard on the openai-completions wire", () => {
	beforeEach(() => {
		mockState.lastParams = undefined;
		mockState.chunks = undefined;
	});
	afterEach(() => {
		delete process.env.PIT_NO_TOOLNAME_GUARD;
	});

	it("sends sanitized tool defs and remaps the response tool call back to the original name", async () => {
		mockState.chunks = [
			{
				id: "chatcmpl-guard",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "my_weird_tool", arguments: '{"ok":true}' },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = openaiCompletionsModel()!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "go", timestamp: Date.now() }],
				tools: [tool("my:weird/tool")],
			},
			{ apiKey: "test" },
		).result();

		// Request: tool definition carries the sanitized wire name.
		expect(mockState.lastParams.tools[0].function.name).toBe("my_weird_tool");

		// Response: tool call surfaces to the caller under the original name.
		expect(response.stopReason).toBe("toolUse");
		const call = response.content.find((b) => b.type === "toolCall");
		expect(call && call.type === "toolCall" && call.name).toBe("my:weird/tool");
	});

	it("replays historical tool calls under the sanitized wire name", async () => {
		mockState.chunks = [
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];
		const { compat: _compat, ...baseModel } = openaiCompletionsModel()!;
		const model = { ...baseModel, api: "openai-completions" } as Model<"openai-completions">;
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: model.id,
			content: [{ type: "toolCall", id: "call_1", name: "my:weird/tool", arguments: { ok: true } }],
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
					{ role: "user", content: "go", timestamp: Date.now() },
					assistant,
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "my:weird/tool",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "again", timestamp: Date.now() },
				],
				tools: [tool("my:weird/tool")],
			},
			{ apiKey: "test" },
		).result();

		const replayed = mockState.lastParams.messages.find((m: any) => m.role === "assistant");
		expect(replayed.tool_calls[0].function.name).toBe("my_weird_tool");
	});

	it("sanitizes a replayed historical tool call whose tool was removed (active guard)", async () => {
		// The guard is ACTIVE because a current tool name is invalid, but the replayed
		// history references a DIFFERENT, since-removed tool absent from the tool set.
		mockState.chunks = [
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];
		const { compat: _compat, ...baseModel } = openaiCompletionsModel()!;
		const model = { ...baseModel, api: "openai-completions" } as Model<"openai-completions">;
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: model.id,
			content: [{ type: "toolCall", id: "call_1", name: "gone:mcp/tool", arguments: { ok: true } }],
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
					{ role: "user", content: "go", timestamp: Date.now() },
					assistant,
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "gone:mcp/tool",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "again", timestamp: Date.now() },
				],
				// A different current tool with an invalid name makes the guard active.
				tools: [tool("present:tool")],
			},
			{ apiKey: "test" },
		).result();

		const replayed = mockState.lastParams.messages.find((m: any) => m.role === "assistant");
		// Before the fix this went out raw ("gone:mcp/tool") and poisoned every turn.
		expect(replayed.tool_calls[0].function.name).toBe("gone_mcp_tool");
	});

	it("sanitizes a replayed historical tool call under the no-op guard (all current tools valid)", async () => {
		// Every current tool is valid -> guard is the shared no-op. A historical
		// tool call with an invalid name must STILL be sanitized on the wire.
		mockState.chunks = [
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];
		const { compat: _compat, ...baseModel } = openaiCompletionsModel()!;
		const model = { ...baseModel, api: "openai-completions" } as Model<"openai-completions">;
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: model.id,
			content: [{ type: "toolCall", id: "call_1", name: "removed:mcp/tool", arguments: { ok: true } }],
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
					{ role: "user", content: "go", timestamp: Date.now() },
					assistant,
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "removed:mcp/tool",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "again", timestamp: Date.now() },
				],
				// Entirely valid current tool set -> the shared no-op guard.
				tools: [tool("read")],
			},
			{ apiKey: "test" },
		).result();

		const replayed = mockState.lastParams.messages.find((m: any) => m.role === "assistant");
		expect(replayed.tool_calls[0].function.name).toBe("removed_mcp_tool");
	});

	it("routes the tool-result name through the historical remap (Bug 6: matches the wire call name)", async () => {
		// requiresToolResultName forces `name` onto the tool message; it must equal the
		// WIRE name the paired tool_call went out under, not the raw original name.
		mockState.chunks = [
			{
				choices: [{ delta: {}, finish_reason: "stop" }],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];
		const { compat: _compat, ...baseModel } = openaiCompletionsModel()!;
		const model = {
			...baseModel,
			api: "openai-completions",
			compat: { requiresToolResultName: true },
		} as Model<"openai-completions">;
		const assistant: AssistantMessage = {
			role: "assistant",
			api: "openai-completions",
			provider: "openai",
			model: model.id,
			content: [{ type: "toolCall", id: "call_1", name: "my:weird/tool", arguments: { ok: true } }],
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
					{ role: "user", content: "go", timestamp: Date.now() },
					assistant,
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "my:weird/tool",
						content: [{ type: "text", text: "done" }],
						isError: false,
						timestamp: Date.now(),
					},
					{ role: "user", content: "again", timestamp: Date.now() },
				],
				tools: [tool("my:weird/tool")],
			},
			{ apiKey: "test" },
		).result();

		const toolResult = mockState.lastParams.messages.find((m: any) => m.role === "tool");
		const assistantMsg = mockState.lastParams.messages.find((m: any) => m.role === "assistant");
		// Bug 6: before the fix this was the raw "my:weird/tool", desynced from the call.
		expect(toolResult.name).toBe("my_weird_tool");
		// It matches the wire name the paired call went out under.
		expect(assistantMsg.tool_calls[0].function.name).toBe("my_weird_tool");
	});

	it("does not remap when the kill-switch disables the guard", async () => {
		process.env.PIT_NO_TOOLNAME_GUARD = "1";
		mockState.chunks = [
			{
				id: "chatcmpl-guard-off",
				choices: [
					{
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "call_1",
									type: "function",
									function: { name: "my:weird/tool", arguments: "{}" },
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
				usage: {
					prompt_tokens: 1,
					completion_tokens: 1,
					prompt_tokens_details: { cached_tokens: 0 },
					completion_tokens_details: { reasoning_tokens: 0 },
				},
			},
		];

		const { compat: _compat, ...baseModel } = openaiCompletionsModel()!;
		const model = { ...baseModel, api: "openai-completions" } as const;
		const response = await streamSimple(
			model,
			{
				messages: [{ role: "user", content: "go", timestamp: Date.now() }],
				tools: [tool("my:weird/tool")],
			},
			{ apiKey: "test" },
		).result();

		// Raw name goes out verbatim and comes back verbatim (no remap).
		expect(mockState.lastParams.tools[0].function.name).toBe("my:weird/tool");
		const call = response.content.find((b) => b.type === "toolCall");
		expect(call && call.type === "toolCall" && call.name).toBe("my:weird/tool");
	});
});
