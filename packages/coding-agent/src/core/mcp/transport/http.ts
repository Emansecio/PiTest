/**
 * Streamable-HTTP transport (MCP spec 2025-03-26+).
 *
 * Each JSON-RPC request is an independent POST. The server answers with either
 * `application/json` (single response) or `text/event-stream` (one or more SSE
 * frames, of which we take the JSON-RPC message matching our request id). There
 * is no persistent socket. `Mcp-Session-Id` from the initialize response is
 * echoed on every later request. The JSON path is byte-identical to the original
 * `McpHttpClient` HTTP code it was extracted from; the SSE-response path is new
 * (the old code rejected SSE outright).
 */

import { recordDiagnostic } from "@pit/ai";
import type { McpServerConfig } from "../types.ts";
import { parseSseStream } from "./sse-parse.ts";
import {
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type McpTransport,
	McpTransportError,
} from "./types.ts";

// Hard ceiling on an MCP response body. A misbehaving/untrusted server returning
// a multi-GB body would otherwise OOM the process. 25MB is far above any
// legitimate JSON-RPC payload but finite. Enforced before materializing the
// body: by Content-Length when present, otherwise by capping the stream read.
const MAX_MCP_RESPONSE_BYTES = 25 * 1024 * 1024;

/**
 * Read a response body to a string under MAX_MCP_RESPONSE_BYTES.
 *
 * If Content-Length is present and exceeds the cap, reject without reading any
 * body. Otherwise read the stream chunk-by-chunk, and if the accumulated size
 * crosses the cap, cancel the body and reject — the whole body is never
 * materialized first. Normal (small) responses read identically to text().
 */
async function readBodyWithCap(response: Response, label: string): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_MCP_RESPONSE_BYTES) {
		recordDiagnostic({
			category: "output.cap",
			level: "error",
			source: "mcp.rpc",
			context: { bytes: declared, note: label },
		});
		throw new McpTransportError(`${label}: MCP response too large (${declared} bytes)`);
	}
	const stream = response.body;
	if (!stream) {
		const text = await response.text();
		const size = new TextEncoder().encode(text).length;
		if (size > MAX_MCP_RESPONSE_BYTES) {
			recordDiagnostic({
				category: "output.cap",
				level: "error",
				source: "mcp.rpc",
				context: { bytes: size, note: label },
			});
			throw new McpTransportError(`${label}: MCP response too large (${size} bytes)`);
		}
		return text;
	}
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_MCP_RESPONSE_BYTES) {
				await reader.cancel().catch(() => {});
				recordDiagnostic({
					category: "output.cap",
					level: "error",
					source: "mcp.rpc",
					context: { bytes: total, note: label },
				});
				throw new McpTransportError(`${label}: MCP response too large (>${MAX_MCP_RESPONSE_BYTES} bytes)`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	return new TextDecoder().decode(concatChunks(chunks, total));
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

export class HttpTransport implements McpTransport {
	onNotification?: (method: string, params?: Record<string, unknown>) => void;
	private name: string;
	private config: McpServerConfig;
	// Streamable HTTP session id. Spec-compliant servers (official SDK with a
	// session generator) return `Mcp-Session-Id` on the initialize response and
	// require it echoed on every subsequent request, else they answer 4xx and the
	// server appears permanently disconnected. Captured from any response that
	// carries it; cleared on dispose / start.
	private sessionId?: string;

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
	}

	updateConfig(config: McpServerConfig): void {
		this.config = config;
	}

	// HTTP is stateless; "start" just drops a stale session id so the next
	// initialize handshake gets a fresh one (mirrors the old clearSessionId()).
	async start(): Promise<void> {
		this.sessionId = undefined;
	}

	dispose(): void {
		this.sessionId = undefined;
	}

	private baseHeaders(accept: string): Record<string, string> {
		return {
			"content-type": "application/json",
			accept,
			...(this.config.headers ?? {}),
			// Echo the server-assigned session id on every request after initialize.
			// Placed last so it is authoritative over config.headers.
			...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
		};
	}

	async request<T = unknown>(
		message: JsonRpcRequest,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<JsonRpcResponse<T>> {
		const method = message.method;
		const controller = new AbortController();
		const effectiveTimeout = timeoutMs ?? this.config.timeoutMs ?? 30_000;
		const timer = setTimeout(() => controller.abort(), effectiveTimeout);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		// The timeout and outer-abort forwarding must stay armed through the BODY
		// reads, not just the fetch: a server that returns headers and then stalls
		// the body would otherwise hang the read forever with no way for the user's
		// abort to reach controller.abort(). Single cleanup point in the finally.
		try {
			let response: Response;
			try {
				response = await fetch(this.config.url ?? "", {
					method: "POST",
					// Accept both so a Streamable-HTTP server may answer either way.
					headers: this.baseHeaders("application/json, text/event-stream"),
					body: JSON.stringify(message),
					signal: controller.signal,
				});
			} catch (error) {
				const m = error instanceof Error ? error.message : String(error);
				throw new McpTransportError(`MCP ${this.name} ${method}: ${m}`);
			}

			const incomingSessionId = response.headers.get("mcp-session-id");
			if (incomingSessionId) this.sessionId = incomingSessionId;

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new McpTransportError(`MCP ${this.name} ${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
			}

			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream")) {
				return await this.readSseResponse<T>(response, message.id, method, controller.signal);
			}

			const rawBody = await readBodyWithCap(response, `MCP ${this.name} ${method}`);
			try {
				return JSON.parse(rawBody) as JsonRpcResponse<T>;
			} catch (error) {
				const m = error instanceof Error ? error.message : String(error);
				throw new McpTransportError(`MCP ${this.name} ${method}: invalid JSON response (${m})`);
			}
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Drain an SSE response and return the JSON-RPC message matching `id`. */
	private async readSseResponse<T>(
		response: Response,
		id: number | string,
		method: string,
		signal: AbortSignal,
	): Promise<JsonRpcResponse<T>> {
		if (!response.body) {
			throw new McpTransportError(`MCP ${this.name} ${method}: SSE response with no body`);
		}
		// Forward the request's abort/timeout signal so a stalled SSE body is
		// cancelled deterministically (not only via the fetch stream teardown).
		for await (const ev of parseSseStream(response.body, {
			signal,
			label: `MCP ${this.name} ${method}`,
			maxBytes: MAX_MCP_RESPONSE_BYTES,
		})) {
			if (!ev.data) continue;
			let parsed: JsonRpcResponse<T>;
			try {
				parsed = JSON.parse(ev.data) as JsonRpcResponse<T>;
			} catch {
				continue; // ignore non-JSON frames (heartbeats etc.)
			}
			// The response to our request ends the drain; a server notification
			// (method, no matching id) interleaved on the stream is forwarded.
			if (parsed && typeof parsed === "object" && "id" in parsed && parsed.id === id) {
				return parsed;
			}
			const note = parsed as { method?: string; params?: Record<string, unknown> };
			if (note && typeof note.method === "string" && !("id" in (parsed as object))) {
				this.onNotification?.(note.method, note.params);
			}
		}
		throw new McpTransportError(`MCP ${this.name} ${method}: SSE stream ended without a matching response`);
	}

	async notify(message: JsonRpcNotification, signal?: AbortSignal): Promise<void> {
		// Fire-and-forget: notifications have no response. Bounded by a 10s timeout
		// and the outer signal so a hung server can't wedge the handshake.
		try {
			await fetch(this.config.url ?? "", {
				method: "POST",
				headers: this.baseHeaders("application/json, text/event-stream"),
				body: JSON.stringify(message),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
			});
		} catch {
			/* Notification failures are non-fatal */
		}
	}
}
