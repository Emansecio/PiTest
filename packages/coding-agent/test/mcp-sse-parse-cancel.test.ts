/**
 * Regression for bughunt #31: parseSseStream must cancel the underlying stream
 * (not merely releaseLock) when the consumer breaks out of the for-await early.
 *
 * The Streamable-HTTP transport returns from readSseResponse() as soon as it
 * finds the JSON-RPC frame matching its request id. That early-return triggers
 * the generator's return() → finally. Releasing the reader lock alone does NOT
 * return the body's socket to the pool in undici, so each successful SSE-mode
 * tool call leaked a connection. The fix calls reader.cancel() on the
 * non-drained exit path.
 */

import { describe, expect, it } from "vitest";
import { parseSseStream } from "../src/core/mcp/transport/sse-parse.js";

function makeStream(frames: string[], onCancel: () => void): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let i = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (i < frames.length) {
				controller.enqueue(encoder.encode(frames[i]!));
				i++;
			} else {
				// Stay open (a real SSE stream keeps the connection alive after the
				// response frame) so only an explicit cancel releases it.
			}
		},
		cancel() {
			onCancel();
		},
	});
}

describe("parseSseStream cancellation (#31)", () => {
	it("cancels the underlying stream on early break (does not just releaseLock)", async () => {
		let cancelled = false;
		const stream = makeStream(['event: message\ndata: {"id":1}\n\n'], () => {
			cancelled = true;
		});

		// Consume one frame and break early, mimicking readSseResponse's early-return.
		for await (const ev of parseSseStream(stream)) {
			expect(ev.data).toBe('{"id":1}');
			break;
		}

		expect(cancelled).toBe(true);
	});

	it("does not cancel when the stream drains naturally to completion", async () => {
		let cancelled = false;
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('event: message\ndata: {"id":1}\n\n'));
				controller.close();
			},
			cancel() {
				cancelled = true;
			},
		});

		const events: string[] = [];
		for await (const ev of parseSseStream(stream)) {
			events.push(ev.data);
		}

		expect(events).toEqual(['{"id":1}']);
		// A fully-drained stream is already closed; no cancel needed.
		expect(cancelled).toBe(false);
	});
});
