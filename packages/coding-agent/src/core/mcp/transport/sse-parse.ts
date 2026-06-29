/**
 * Minimal Server-Sent Events (SSE) frame parser over a `ReadableStream`.
 *
 * Shared by the Streamable-HTTP transport (a POST may answer with an SSE stream
 * carrying the JSON-RPC response) and the legacy HTTP+SSE transport (a long-lived
 * GET event channel). Implements the subset of the SSE spec MCP servers use:
 * `event:`, `data:` (multiple lines joined by `\n`), `id:`, `:`-comments, and a
 * blank line dispatching the accumulated frame. A byte cap stops an endless
 * stream from growing the buffer to OOM (mirrors the MCP HTTP body cap).
 */

import { DEFAULT_IDLE_TIMEOUT_MS, raceReadWithIdle } from "@pit/ai";
import { McpTransportError } from "./types.ts";

export interface SseEvent {
	event: string;
	data: string;
	id?: string;
}

const DEFAULT_MAX_SSE_BYTES = 25 * 1024 * 1024;

export async function* parseSseStream(
	stream: ReadableStream<Uint8Array>,
	opts: { maxBytes?: number; signal?: AbortSignal; label?: string; idleMs?: number } = {},
): AsyncGenerator<SseEvent> {
	// Cap the UNFLUSHED buffer (one in-progress frame), not the cumulative byte
	// count: a legitimate long-lived SSE channel streams far past any total cap,
	// but a single frame with no terminating newline is the real OOM vector.
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_SSE_BYTES;
	const idleMs = opts.idleMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const label = opts.label ?? "SSE";
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let eventType = "";
	let dataLines: string[] = [];
	let lastId: string | undefined;

	const flush = (): SseEvent | undefined => {
		if (dataLines.length === 0 && eventType === "") return undefined;
		const ev: SseEvent = { event: eventType || "message", data: dataLines.join("\n") };
		if (lastId !== undefined) ev.id = lastId;
		eventType = "";
		dataLines = [];
		return ev;
	};

	const onAbort = () => reader.cancel().catch(() => {});
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	// Track whether the stream drained naturally. If the consumer breaks out of
	// the for-await early (e.g. Streamable-HTTP found its matching JSON-RPC
	// response), the generator's `return()` runs `finally` while the body is only
	// half-read; releaseLock() alone does NOT return the socket to the pool --
	// the connection leaks until GC/socket-timeout. Cancel the reader in that
	// case so the underlying HTTP connection is released deterministically.
	let drained = false;
	try {
		while (true) {
			const { done, value } = await raceReadWithIdle(reader, { idleMs, signal: opts.signal });
			if (done) {
				const tail = decoder.decode();
				if (tail.length > 0) {
					buffer += tail;
				}
				drained = true;
			} else if (!value) {
				continue;
			} else {
				buffer += decoder.decode(value, { stream: true });
			}
			if (buffer.length > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new McpTransportError(`${label}: SSE frame too large (>${maxBytes} bytes without a frame boundary)`);
			}
			// Walk with a cursor and slice ONCE per chunk, instead of re-slicing the
			// whole remainder per line -- per-line slicing is O(lines * bytes) ~ O(B^2)
			// on one large multi-line frame (stdio avoids this via coalesceChunks).
			let pos = 0;
			let newlineIndex = buffer.indexOf("\n", pos);
			while (newlineIndex !== -1) {
				// Strip an optional trailing \r so CRLF and LF frames parse identically.
				let line = buffer.slice(pos, newlineIndex);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				pos = newlineIndex + 1;
				if (line === "") {
					const ev = flush();
					if (ev) yield ev;
				} else if (line.startsWith(":")) {
					// Comment / heartbeat -- ignore.
				} else {
					const colon = line.indexOf(":");
					const field = colon === -1 ? line : line.slice(0, colon);
					let val = colon === -1 ? "" : line.slice(colon + 1);
					if (val.startsWith(" ")) val = val.slice(1);
					if (field === "event") eventType = val;
					else if (field === "data") dataLines.push(val);
					else if (field === "id") lastId = val;
				}
				newlineIndex = buffer.indexOf("\n", pos);
			}
			// Drop the consumed prefix; keep only the unterminated trailing frame.
			if (pos > 0) buffer = buffer.slice(pos);
			if (done) break;
		}
		// A final frame not terminated by a blank line (stream closed) still dispatches.
		const ev = flush();
		if (ev) yield ev;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		// Early-return / break before the stream finished: cancel so the body and
		// its socket are released (releaseLock alone leaks the connection in undici).
		if (!drained) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
