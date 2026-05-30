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

export class McpHttpClient {
	private name: string;
	private config: McpServerConfig;
	private nextId = 1;
	private initialized = false;
	private serverInfo?: { name?: string; version?: string };
	private tools: McpToolSchema[] = [];

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
				},
				body: JSON.stringify(body),
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`MCP ${this.name} ${method}: HTTP ${response.status} ${text.slice(0, 200)}`);
		}

		// Some servers stream SSE on the same endpoint. We only support the
		// single-response JSON variant; reject SSE responses to avoid hanging.
		const contentType = response.headers.get("content-type") ?? "";
		if (contentType.includes("text/event-stream")) {
			throw new Error(`MCP ${this.name} ${method}: SSE transport not supported (use HTTP JSON)`);
		}

		const json = (await response.json()) as JsonRpcResponse<T>;
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
				},
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
				signal,
			});
		} catch {
			/* Notification failures are non-fatal */
		}

		await this.refreshTools(signal);
		this.initialized = true;
	}

	async refreshTools(signal?: AbortSignal): Promise<McpToolSchema[]> {
		const result = await this.rpc<McpListToolsResult>("tools/list", {}, signal);
		this.tools = Array.isArray(result.tools) ? result.tools : [];
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
	}
}
