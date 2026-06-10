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

import type { McpCallToolResult, McpListToolsResult, McpServerConfig, McpToolSchema } from "./types.ts";

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "pi-coding-agent", version: "0.1.0" };

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
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
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

		let json: JsonRpcResponse<T>;
		try {
			json = (await response.json()) as JsonRpcResponse<T>;
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
	}

	async initialize(signal?: AbortSignal): Promise<void> {
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
