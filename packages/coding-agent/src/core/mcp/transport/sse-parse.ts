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

import { McpTransportError } from "./types.ts";

export interface SseEvent {
	event: string;
	data: string;
	id?: string;
}

const DEFAULT_MAX_SSE_BYTES = 25 * 1024 * 1024;

export async function* parseSseStream(
	stream: ReadableStream<Uint8Array>,
	opts: { maxBytes?: number; signal?: AbortSignal; label?: string } = {},
): AsyncGenerator<SseEvent> {
	// Cap the UNFLUSHED buffer (one in-progress frame), not the cumulative byte
	// count: a legitimate long-lived SSE channel streams far past any total cap,
	// but a single frame with no terminating newline is the real OOM vector.
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_SSE_BYTES;
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
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			buffer += decoder.decode(value, { stream: true });
			if (buffer.length > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new McpTransportError(`${label}: SSE frame too large (>${maxBytes} bytes without a frame boundary)`);
			}
			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				// Strip an optional trailing \r so CRLF and LF frames parse identically.
				let line = buffer.slice(0, newlineIndex);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				buffer = buffer.slice(newlineIndex + 1);
				if (line === "") {
					const ev = flush();
					if (ev) yield ev;
				} else if (line.startsWith(":")) {
					// Comment / heartbeat — ignore.
				} else {
					const colon = line.indexOf(":");
					const field = colon === -1 ? line : line.slice(0, colon);
					let val = colon === -1 ? "" : line.slice(colon + 1);
					if (val.startsWith(" ")) val = val.slice(1);
					if (field === "event") eventType = val;
					else if (field === "data") dataLines.push(val);
					else if (field === "id") lastId = val;
				}
				newlineIndex = buffer.indexOf("\n");
			}
		}
		// A final frame not terminated by a blank line (stream closed) still dispatches.
		const ev = flush();
		if (ev) yield ev;
	} finally {
		opts.signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}
}
