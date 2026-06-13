/**
 * Minimal JSON-RPC 2.0 client for MCP over HTTP.
 *
 * Connect performs an `initialize` round-trip then a `tools/list`. Subsequent
 * `tools/call` requests reuse the same fetch transport. There is no persistent
 * socket — the HTTP transport in the MCP spec is request/response, so we treat
 * each call as an independent POST.
 *
 * Reconnect = re-run initialize + tools/list. The manager handles backoff.
 */

import { recordDiagnostic } from "@pit/ai";
import type { McpCallToolResult, McpListToolsResult, McpServerConfig, McpToolSchema } from "./types.ts";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "pi-coding-agent", version: "0.1.0" };

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
		// Observe the cap before rejecting (behavior unchanged).
		recordDiagnostic({
			category: "output.cap",
			level: "error",
			source: "mcp.rpc",
			context: { bytes: declared, note: label },
		});
		throw new McpTransportError(`${label}: MCP response too large (${declared} bytes)`);
	}
	const stream = response.body;
	// No stream body (mock/empty): fall back to text(), still bounded after read.
	if (!stream) {
		const text = await response.text();
		const size = new TextEncoder().encode(text).length;
		if (size > MAX_MCP_RESPONSE_BYTES) {
			// Observe the cap before rejecting (behavior unchanged).
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
				// Observe the cap before rejecting (behavior unchanged).
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

/** Join the collected byte chunks into one buffer of the known total length. */
function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: number | string;
	result?: T;
	error?: { code: number; message: string; data?: unknown };
}

/**
 * Transport-level failure (network error, HTTP status, SSE/malformed payload)
 * as opposed to a JSON-RPC application error returned by a live server. The
 * manager only marks a server disconnected — and re-initializes — for these;
 * application errors leave the connection state untouched.
 */
export class McpTransportError extends Error {}

export class McpHttpClient {
	private name: string;
	private config: McpServerConfig;
	private nextId = 1;
	private initialized = false;
	private serverInfo?: { name?: string; version?: string };
	private tools: McpToolSchema[] = [];
	// Streamable HTTP session id. Spec-compliant servers (official SDK with a
	// session generator) return `Mcp-Session-Id` on the initialize response and
	// require it echoed on every subsequent request, else they answer 4xx and the
	// server appears permanently disconnected. Captured from any response that
	// carries it; cleared on dispose.
	private sessionId?: string;

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
	}

	get serverName(): string {
		return this.name;
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	getTools(): McpToolSchema[] {
		return this.tools;
	}

	getServerInfo(): { name?: string; version?: string } | undefined {
		return this.serverInfo;
	}

	private async rpc<T>(
		method: string,
		params?: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutOverrideMs?: number,
	): Promise<T> {
		const id = this.nextId++;
		const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const controller = new AbortController();
		// Connect handshake uses a shorter 15s budget (passed via timeoutOverrideMs);
		// tool calls keep the default 30s so slow MCP tools don't get cut off.
		const timeoutMs = timeoutOverrideMs ?? this.config.timeoutMs ?? 30_000;
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		// The timeout and outer-abort forwarding must stay armed through the BODY
		// reads, not just the fetch: a server that returns headers and then stalls
		// the body would otherwise hang response.json() forever with no way for
		// the user's abort to reach controller.abort(). Single cleanup point in
		// the outer finally.
		try {
			let response: Response;
			try {
				response = await fetch(this.config.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						accept: "application/json",
						...(this.config.headers ?? {}),
						// Echo the server-assigned session id on every request after
						// initialize. Placed last so it is authoritative over config.headers.
						...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});
			} catch (error) {
				// fetch rejection = network/abort/timeout: the request may or may not
				// have reached the server, so this is a transport failure by definition.
				const message = error instanceof Error ? error.message : String(error);
				throw new McpTransportError(`MCP ${this.name} ${method}: ${message}`);
			}

			// Capture the session id from any response that carries one (servers set it
			// on the initialize response). Subsequent requests must echo it.
			const incomingSessionId = response.headers.get("mcp-session-id");
			if (incomingSessionId) this.sessionId = incomingSessionId;

			if (!response.ok) {
				const text = await response.text().catch(() => "");
				throw new McpTransportError(`MCP ${this.name} ${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
			}

			// Some servers stream SSE on the same endpoint. We only support the
			// single-response JSON variant; reject SSE responses to avoid hanging.
			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("text/event-stream")) {
				throw new McpTransportError(`MCP ${this.name} ${method}: SSE transport not supported (use HTTP JSON)`);
			}

			// Read under a size cap BEFORE parsing so an untrusted server can't OOM
			// us with a giant body (checked via Content-Length, else capped stream).
			const rawBody = await readBodyWithCap(response, `MCP ${this.name} ${method}`);
			let json: JsonRpcResponse<T>;
			try {
				json = JSON.parse(rawBody) as JsonRpcResponse<T>;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new McpTransportError(`MCP ${this.name} ${method}: invalid JSON response (${message})`);
			}
			if (json.error) {
				throw new Error(`MCP ${this.name} ${method}: ${json.error.message} (code ${json.error.code})`);
			}
			if (json.result === undefined) {
				throw new Error(`MCP ${this.name} ${method}: response missing result`);
			}
			return json.result;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Discard the current session id (see initialize / dispose for why). */
	private clearSessionId(): void {
		this.sessionId = undefined;
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		// A fresh handshake must not echo a stale session id: the server assigns a new
		// one on initialize, and on reconnect this client instance is reused (the old
		// id would otherwise be rejected, bricking the connection until the session ends).
		// Routed through clearSessionId() so the reset does not narrow this.sessionId to
		// `undefined` for the notifications/initialized header built later in this method.
		this.clearSessionId();
		const result = await this.rpc<{
			serverInfo?: { name?: string; version?: string };
			protocolVersion?: string;
		}>(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {} },
				clientInfo: CLIENT_INFO,
			},
			signal,
			15_000,
		);
		this.serverInfo = result.serverInfo;

		// Send the initialized notification (no response expected, but our rpc
		// path expects one so use a fire-and-forget POST instead).
		try {
			await fetch(this.config.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					accept: "application/json",
					...(this.config.headers ?? {}),
					...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
				},
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
			});
		} catch {
			/* Notification failures are non-fatal */
		}

		await this.refreshTools(signal);
		this.initialized = true;
	}

	async refreshTools(signal?: AbortSignal): Promise<McpToolSchema[]> {
		// tools/list is paginated (MCP spec): follow nextCursor until exhausted so
		// servers with many tools aren't silently truncated to the first page.
		// PAGE_CAP bounds a server that returns a cursor forever; a repeated
		// cursor also breaks the loop (no forward progress).
		const PAGE_CAP = 50;
		const collected: McpToolSchema[] = [];
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < PAGE_CAP; page++) {
			const params: Record<string, unknown> = cursor === undefined ? {} : { cursor };
			const result = await this.rpc<McpListToolsResult>("tools/list", params, signal);
			if (Array.isArray(result.tools)) collected.push(...result.tools);
			const next = result.nextCursor;
			if (typeof next !== "string" || next.length === 0 || seenCursors.has(next)) break;
			seenCursors.add(next);
			cursor = next;
		}
		this.tools = collected;
		return this.tools;
	}

	async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult> {
		const result = await this.rpc<McpCallToolResult>("tools/call", { name: toolName, arguments: args }, signal);
		return result;
	}

	updateConfig(config: McpServerConfig): void {
		this.config = config;
	}

	dispose(): void {
		this.initialized = false;
		this.tools = [];
		// Drop the session id so a reconnect performs a fresh initialize handshake
		// instead of replaying a stale (server-expired) session.
		this.sessionId = undefined;
	}
}
