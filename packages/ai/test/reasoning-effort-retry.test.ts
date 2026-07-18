import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamSimple } from "../src/stream.js";
import type { Model, Tool } from "../src/types.js";
import { getRuntimeDiagnostics, resetRuntimeDiagnostics } from "../src/utils/runtime-diagnostics.js";
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
	// Number of subsequent connects that should hang forever (never settle) so the
	// connect guard's ceiling — not the SDK default — is what bounds them.
	hangRemaining: 0,
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
						if (mockState.hangRemaining > 0) {
							mockState.hangRemaining--;
							// Never settles: the connect guard must abort this via its ceiling.
							return new Promise(() => {});
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
		mockState.hangRemaining = 0;
		resetRuntimeDiagnostics();
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

	// Fix 10a: the memo is scoped to the failing VALUE, not the whole model, so a
	// 400 on one effort value never silently disables a different, valid value.
	it("memoizes the failing effort VALUE only — a different value is still attempted", async () => {
		const model = reasoningModel("retry-model-value-scope");

		// "high" is rejected once, then memoized.
		mockState.failuresRemaining = 1;
		mockState.failError = reasoningEffort400();
		await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();
		expect(mockState.calls).toHaveLength(2); // 400 + retry stripped

		// Same value again → stripped up front (memoized), single call.
		mockState.calls = [];
		await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();
		expect(mockState.calls).toHaveLength(1);
		expect(mockState.calls[0].reasoning_effort).toBeUndefined();

		// A DIFFERENT value ("low") is NOT suppressed — it goes out normally.
		mockState.calls = [];
		const response = await streamSimple(model, context(), { apiKey: "test", reasoning: "low" }).result();
		expect(response.stopReason).not.toBe("error");
		expect(mockState.calls).toHaveLength(1);
		expect(mockState.calls[0].reasoning_effort).toBe("low");
	});

	// Fix 10b: stripping reasoning_effort must not be silent — one diagnostic per
	// strip, on both the retry path and the later preventive (memoized) path.
	it("emits a visible diagnostic whenever reasoning_effort is stripped", async () => {
		const model = reasoningModel("retry-model-diagnostic");

		// Retry path → diagnostic with mechanism "retry".
		mockState.failuresRemaining = 1;
		mockState.failError = reasoningEffort400();
		await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();

		let diags = getRuntimeDiagnostics();
		expect(diags.counters["provider.reasoning-effort-stripped"]?.count).toBe(1);
		expect(diags.recent.at(-1)?.context?.mechanism).toBe("retry");

		// Preventive (memoized) path → a second diagnostic with mechanism "memo".
		await streamSimple(model, context(), { apiKey: "test", reasoning: "high" }).result();
		diags = getRuntimeDiagnostics();
		expect(diags.counters["provider.reasoning-effort-stripped"]?.count).toBe(2);
		expect(diags.recent.at(-1)?.context?.mechanism).toBe("memo");
	});

	// Fix 11: the retry's connect must stay under the guard's ceiling. The connect
	// timer is single-shot (cleared by the first settle); the retry re-arms it, so a
	// frozen retry connect is aborted by the ceiling — not the SDK's multi-min default.
	it("bounds a hanging retry connect with the re-armed guard ceiling", async () => {
		mockState.failuresRemaining = 1;
		mockState.failError = reasoningEffort400();
		mockState.hangRemaining = 1; // the retry connect hangs forever

		const model = reasoningModel("retry-model-connect-ceiling");
		const response = await streamSimple(model, context(), {
			apiKey: "test",
			reasoning: "high",
			timeoutMs: 30, // resolveStreamTimeouts uses this as the connect-ceiling fallback
		}).result();

		expect(mockState.calls).toHaveLength(2); // initial 400 + the hanging retry
		expect(response.stopReason).toBe("error");
		expect(response.errorMessage ?? "").toMatch(/timed out/i);
	});
});
