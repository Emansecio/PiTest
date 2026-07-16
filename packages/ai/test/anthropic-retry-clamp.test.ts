/**
 * Hermetic tests for the Anthropic SDK maxRetries clamp (perf audit §2.4).
 *
 * The Anthropic SDK defaults to 2 silent retries with exponential backoff —
 * a pre-TTFT stall invisible to the TUI that stacks on Pit's own retry/
 * fallback layer. The provider clamps the default to exactly 1 in-SDK retry
 * (enough to absorb the intermittent OAuth 529 blip without burning a
 * fallback-chain entry). Caller-provided values always win, and
 * PIT_NO_PROVIDER_RETRY_CLAMP=1 restores the SDK default (no maxRetries sent).
 */

import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

const minimalEvents = [
	{
		event: "message_start",
		data: JSON.stringify({
			type: "message_start",
			message: {
				id: "msg_test",
				usage: { input_tokens: 1, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		}),
	},
	{
		event: "content_block_start",
		data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
	},
	{
		event: "content_block_delta",
		data: JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }),
	},
	{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
	{
		event: "message_delta",
		data: JSON.stringify({
			type: "message_delta",
			delta: { stop_reason: "end_turn" },
			usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		}),
	},
	{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
];

function createSseResponse(): Response {
	const body = minimalEvents.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface CapturedRequestOptions {
	maxRetries?: number;
}

function createCapturingClient(captured: { requestOptions?: CapturedRequestOptions }): Anthropic {
	return {
		messages: {
			create: (_params: unknown, requestOptions: CapturedRequestOptions) => {
				captured.requestOptions = requestOptions;
				return { asResponse: async () => createSseResponse() };
			},
		},
	} as unknown as Anthropic;
}

describe("Anthropic maxRetries clamp (PIT_NO_PROVIDER_RETRY_CLAMP)", () => {
	const originalEnv = process.env.PIT_NO_PROVIDER_RETRY_CLAMP;
	const context: Context = {
		messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
	};
	const model = getModel("anthropic", "claude-haiku-4-5");

	beforeEach(() => {
		delete process.env.PIT_NO_PROVIDER_RETRY_CLAMP;
	});

	afterEach(() => {
		if (originalEnv !== undefined) {
			process.env.PIT_NO_PROVIDER_RETRY_CLAMP = originalEnv;
		} else {
			delete process.env.PIT_NO_PROVIDER_RETRY_CLAMP;
		}
	});

	it("defaults maxRetries to 1 when the caller does not set it", async () => {
		const captured: { requestOptions?: CapturedRequestOptions } = {};
		await streamAnthropic(model, context, { client: createCapturingClient(captured) }).result();

		expect(captured.requestOptions?.maxRetries).toBe(1);
	});

	it("honors an explicit caller maxRetries over the clamp", async () => {
		const captured: { requestOptions?: CapturedRequestOptions } = {};
		await streamAnthropic(model, context, { client: createCapturingClient(captured), maxRetries: 4 }).result();

		expect(captured.requestOptions?.maxRetries).toBe(4);
	});

	it("honors an explicit maxRetries of 0 (no silent retries at all)", async () => {
		const captured: { requestOptions?: CapturedRequestOptions } = {};
		await streamAnthropic(model, context, { client: createCapturingClient(captured), maxRetries: 0 }).result();

		expect(captured.requestOptions?.maxRetries).toBe(0);
	});

	it("PIT_NO_PROVIDER_RETRY_CLAMP=1 restores the SDK default (option omitted)", async () => {
		process.env.PIT_NO_PROVIDER_RETRY_CLAMP = "1";
		const captured: { requestOptions?: CapturedRequestOptions } = {};
		await streamAnthropic(model, context, { client: createCapturingClient(captured) }).result();

		expect(captured.requestOptions).toBeDefined();
		expect("maxRetries" in (captured.requestOptions ?? {})).toBe(false);
	});
});
