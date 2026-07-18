import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Model, Tool } from "../src/types.js";
import { openaiCompletionsModel } from "./helpers/pruned-fixtures.js";

const pingTool: Tool = {
	name: "ping",
	description: "Ping",
	parameters: Type.Object({ ok: Type.Boolean() }),
};

function reasoningModel(id: string): Model<"openai-completions"> {
	return { ...openaiCompletionsModel(id), reasoning: true };
}

const okChunks = [
	{
		id: "chatcmpl-ok",
		choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
		usage: {
			prompt_tokens: 1,
			completion_tokens: 1,
			prompt_tokens_details: { cached_tokens: 0 },
			completion_tokens_details: { reasoning_tokens: 0 },
		},
	},
];

const mockState = vi.hoisted(() => ({
	calls: [] as any[],
	failuresRemaining: 0,
	failError: undefined as any,
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (params: unknown) => {
					// Snapshot: the retry mutates the params object in place, so a stored
					// reference would reflect the post-strip state for every call.
					mockState.calls.push({ ...(params as Record<string, unknown>) });
					const stream = {
						async *[Symbol.asyncIterator]() {
							for (const chunk of okChunks) yield chunk;
						},
					};
					const promise = Promise.resolve(stream) as any;
					promise.withResponse = async () => {
						if (mockState.failuresRemaining > 0) {
							mockState.failuresRemaining--;
							throw mockState.failError;
						}
						return { data: stream, response: { status: 200, headers: new Headers() } };
					};
					return promise;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

function reasoningEffort400(): Error {
	return Object.assign(new Error("400 Invalid request: Unsupported parameter 'reasoning_effort' with tools."), {
		status: 400,
	});
}

function context() {
	return {
		messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }],
		tools: [pingTool],
	};
}

describe("reasoning_effort + tools resilience (chat completions)", () => {
	beforeEach(() => {
		mockState.calls = [];
		mockState.failuresRemaining = 0;
		mockState.failError = undefined;
	});
	afterEach(() => {
		delete process.env.PIT_NO_EFFORT_RETRY;
	});

	it("retries once without reasoning_effort after a 400 that blames it", async () => {
		mockState.failuresRemaining = 1;
		mockState.failError = reasoningEffort400();

		const model = reasoningModel("retry-model-a");
		const response = await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();

		expect(response.stopReason).not.toBe("error");
		expect(mockState.calls).toHaveLength(2);
		expect(mockState.calls[0].reasoning_effort).toBe("high");
		expect(mockState.calls[1].reasoning_effort).toBeUndefined();
	});

	it("memoizes the rejection so the next request omits reasoning_effort up front", async () => {
		const model = reasoningModel("retry-model-b");

		// First request: 400 then a successful retry that records the memo.
		mockState.failuresRemaining = 1;
		mockState.failError = reasoningEffort400();
		await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();
		expect(mockState.calls).toHaveLength(2);

		// Second request: no failure primed; reasoning_effort must be absent already.
		mockState.calls = [];
		mockState.failuresRemaining = 0;
		const response = await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();
		expect(response.stopReason).not.toBe("error");
		expect(mockState.calls).toHaveLength(1);
		expect(mockState.calls[0].reasoning_effort).toBeUndefined();
	});

	it("does not retry when a 400 is unrelated to reasoning_effort", async () => {
		mockState.failuresRemaining = 1;
		mockState.failError = Object.assign(new Error("400 Invalid request: bad 'temperature' value."), {
			status: 400,
		});

		const model = reasoningModel("retry-model-c");
		const response = await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();

		expect(response.stopReason).toBe("error");
		expect(mockState.calls).toHaveLength(1);
		expect(mockState.calls[0].reasoning_effort).toBe("high");
	});

	it("does not retry when the kill-switch PIT_NO_EFFORT_RETRY is set", async () => {
		process.env.PIT_NO_EFFORT_RETRY = "1";
		mockState.failuresRemaining = 1;
		mockState.failError = reasoningEffort400();

		const model = reasoningModel("retry-model-d");
		const response = await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();

		expect(response.stopReason).toBe("error");
		expect(mockState.calls).toHaveLength(1);
	});
});
