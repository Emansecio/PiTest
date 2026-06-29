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

import { IdleStreamTimeoutError } from "@pit/ai";
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

describe("parseSseStream idle timeout", () => {
	it("cancels the stream when the body stalls past idleMs", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				// Never settle — half-open SSE body.
				return new Promise(() => {});
			},
			cancel() {
				cancelled = true;
			},
		});

		const start = Date.now();
		await expect(async () => {
			for await (const _ev of parseSseStream(stream, { idleMs: 50 })) {
				// no events expected
			}
		}).rejects.toBeInstanceOf(IdleStreamTimeoutError);
		expect(Date.now() - start).toBeLessThan(5000);
		expect(cancelled).toBe(true);
	});
});

describe("parseSseStream framing (cursor-walk)", () => {
	function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
		const encoder = new TextEncoder();
		let i = 0;
		return new ReadableStream<Uint8Array>({
			pull(controller) {
				if (i < chunks.length) {
					controller.enqueue(encoder.encode(chunks[i]!));
					i++;
				} else {
					controller.close();
				}
			},
		});
	}

	async function collect(chunks: string[]): Promise<SseEventLite[]> {
		const out: SseEventLite[] = [];
		for await (const ev of parseSseStream(streamFromChunks(chunks))) {
			out.push({ event: ev.event, data: ev.data, id: ev.id });
		}
		return out;
	}

	it("parses multiple frames delivered in a single chunk", async () => {
		const events = await collect(["data: a\n\ndata: b\n\ndata: c\n\n"]);
		expect(events.map((e) => e.data)).toEqual(["a", "b", "c"]);
	});

	it("reassembles a frame split across chunk boundaries (mid-line)", async () => {
		// The newline and even a single data line are split across reads — the cursor
		// walk must carry the partial line in the buffer between reads.
		const events = await collect(["event: mess", 'age\ndata: {"id', '":1,"x":2}\n', "\n"]);
		expect(events).toEqual([{ event: "message", data: '{"id":1,"x":2}', id: undefined }]);
	});

	it("joins multi-line data and honors CRLF identically to LF", async () => {
		const events = await collect(["data: line1\r\ndata: line2\r\n\r\n"]);
		expect(events).toEqual([{ event: "message", data: "line1\nline2", id: undefined }]);
	});

	it("dispatches a final frame not terminated by a blank line on stream close", async () => {
		const events = await collect(["data: tail\n"]);
		expect(events.map((e) => e.data)).toEqual(["tail"]);
	});

	it("ignores comments/heartbeats and tracks id", async () => {
		const events = await collect([": ping\nid: 7\nevent: note\ndata: hi\n\n"]);
		expect(events).toEqual([{ event: "note", data: "hi", id: "7" }]);
	});

	it("flushes a UTF-8 sequence split across the final chunk boundary", async () => {
		const encoder = new TextEncoder();
		const full = encoder.encode("data: \u{1F600}\n\n");
		const splitAt = full.length - 1;
		let step = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (step === 0) {
					controller.enqueue(full.subarray(0, splitAt));
					step = 1;
					return;
				}
				if (step === 1) {
					controller.enqueue(full.subarray(splitAt));
					controller.close();
					step = 2;
				}
			},
		});
		const events: SseEventLite[] = [];
		for await (const ev of parseSseStream(stream)) {
			events.push({ event: ev.event, data: ev.data, id: ev.id });
		}
		expect(events).toEqual([{ event: "message", data: "\u{1F600}", id: undefined }]);
	});
});

interface SseEventLite {
	event: string;
	data: string;
	id?: string;
}
