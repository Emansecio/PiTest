import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamAnthropic } from "../src/providers/anthropic.js";
import type { Context } from "../src/types.js";

/**
 * `message_start` is the ONLY event carrying Anthropic's per-TTL cache-write
 * breakdown (`usage.cache_creation`); `message_delta` restates the cumulative
 * total without it. These cover that the 1h slice survives into `usage`, that a
 * later delta re-derives it instead of dropping it, and that a payload without
 * the breakdown prices exactly as before the split existed.
 */

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as Anthropic;
}

const CONTEXT: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 1 }],
};

function events(opts: {
	startCacheWrite: number;
	cacheCreation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
	deltaCacheWrite?: number;
}): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_test",
					usage: {
						input_tokens: 10,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: opts.startCacheWrite,
						...(opts.cacheCreation ? { cache_creation: opts.cacheCreation } : {}),
					},
				},
			}),
		},
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 10,
					output_tokens: 3,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: opts.deltaCacheWrite ?? opts.startCacheWrite,
				},
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
}

async function run(sse: Array<{ event: string; data: string }>) {
	const model = getModel("anthropic", "claude-haiku-4-5");
	const stream = streamAnthropic(model, CONTEXT, {
		client: createFakeAnthropicClient(createSseResponse(sse)),
	});
	return { model, result: await stream.result() };
}

describe("Anthropic cache-write TTL tier", () => {
	it("carries the 1h slice from message_start into usage", async () => {
		const { result } = await run(
			events({
				startCacheWrite: 8000,
				cacheCreation: { ephemeral_1h_input_tokens: 8000, ephemeral_5m_input_tokens: 0 },
			}),
		);
		expect(result.usage.cacheWrite).toBe(8000);
		expect(result.usage.cacheWriteLong).toBe(8000);
	});

	it("prices an all-1h write above the listed short rate", async () => {
		const { model, result } = await run(
			events({
				startCacheWrite: 8000,
				cacheCreation: { ephemeral_1h_input_tokens: 8000, ephemeral_5m_input_tokens: 0 },
			}),
		);
		const listed = (model.cost.cacheWrite / 1_000_000) * 8000;
		expect(result.usage.cost.cacheWrite).toBeCloseTo(listed * 1.6, 12);
	});

	it("keeps a 5m-only breakdown at the listed rate", async () => {
		const { model, result } = await run(
			events({
				startCacheWrite: 8000,
				cacheCreation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 8000 },
			}),
		);
		expect(result.usage.cacheWriteLong).toBe(0);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((model.cost.cacheWrite / 1_000_000) * 8000, 12);
	});

	it("re-derives the slice when message_delta restates a larger total", async () => {
		const { result } = await run(
			events({
				startCacheWrite: 8000,
				cacheCreation: { ephemeral_1h_input_tokens: 8000, ephemeral_5m_input_tokens: 0 },
				deltaCacheWrite: 12_000,
			}),
		);
		// message_delta has no breakdown; the share captured at message_start (100%
		// long) must survive rather than silently reverting to the short rate.
		expect(result.usage.cacheWrite).toBe(12_000);
		expect(result.usage.cacheWriteLong).toBe(12_000);
	});

	it("splits a mixed breakdown proportionally", async () => {
		const { result } = await run(
			events({
				startCacheWrite: 10_000,
				cacheCreation: { ephemeral_1h_input_tokens: 2500, ephemeral_5m_input_tokens: 7500 },
			}),
		);
		expect(result.usage.cacheWriteLong).toBe(2500);
	});

	it("prices as before when the payload omits cache_creation entirely", async () => {
		const { model, result } = await run(events({ startCacheWrite: 8000 }));
		expect(result.usage.cacheWriteLong).toBe(0);
		expect(result.usage.cost.cacheWrite).toBeCloseTo((model.cost.cacheWrite / 1_000_000) * 8000, 12);
	});
});
