/**
 * McpClient — the JSON-RPC 2.0 layer of an MCP connection.
 *
 * Owns id allocation, the initialize handshake, result/error unwrapping, and the
 * tools/resources/prompts methods. Byte delivery is delegated to an `McpTransport`
 * (HTTP / stdio / SSE — see ./transport), so the protocol code is transport-blind.
 *
 * Reconnect = re-run `initialize` (which re-runs `transport.start()`: a fresh
 * session for HTTP, a fresh subprocess for stdio, a fresh channel for SSE). The
 * manager handles backoff. A failed `tools/call` is never re-sent: tool calls may
 * have side effects, and a timed-out call may already have been applied.
 */

import { resolveServerConfig } from "./config-files.ts";
import { isTokenExpired, loadMcpToken, refreshMcpToken } from "./oauth.ts";
import { createTransport, type McpTransport, McpTransportError } from "./transport/index.ts";
import type {
	McpCallToolResult,
	McpGetPromptResult,
	McpListToolsResult,
	McpPromptDescriptor,
	McpResourceContents,
	McpResourceDescriptor,
	McpServerCapabilities,
	McpServerConfig,
	McpToolSchema,
} from "./types.ts";

export { McpTransportError };

const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "pi-coding-agent", version: "0.1.0" };

interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

export class McpClient {
	private name: string;
	private config: McpServerConfig;
	private transport: McpTransport;
	private nextId = 1;
	private initialized = false;
	private serverInfo?: { name?: string; version?: string };
	private capabilities: McpServerCapabilities = {};
	private tools: McpToolSchema[] = [];
	/** `Bearer <token>` from OAuth, injected when the server has no static Authorization header. */
	private authHeader?: string;

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
		// Attach an existing OAuth token (remote servers only) so the first connect
		// is authenticated without a separate step.
		const token = config.url ? loadMcpToken(name) : undefined;
		if (token) this.authHeader = `Bearer ${token.accessToken}`;
		// Resolve ${VAR} / !cmd in url/headers/env/args at the point of use; the raw
		// config is kept for timeout/display so secrets never land in stored state.
		this.transport = createTransport(name, this.transportConfig());
	}

	/** Whether the user configured a static Authorization header (which takes precedence over OAuth). */
	private hasStaticAuth(): boolean {
		return Object.keys(this.config.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
	}

	/** Resolved config for the transport, with the OAuth bearer merged in when applicable. */
	private transportConfig(): McpServerConfig {
		const resolved = resolveServerConfig(this.config);
		if (this.authHeader && !this.hasStaticAuth()) {
			resolved.headers = { ...(resolved.headers ?? {}), Authorization: this.authHeader };
		}
		return resolved;
	}

	/** Refresh an expired OAuth token before a (re)connect so the handshake is authenticated. */
	private async ensureFreshAuth(): Promise<void> {
		if (!this.config.url) return;
		let token = loadMcpToken(this.name);
		if (token && isTokenExpired(token)) {
			const refreshed = await refreshMcpToken(this.name);
			if (refreshed) token = refreshed;
		}
		if (token) this.authHeader = `Bearer ${token.accessToken}`;
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

	getCapabilities(): McpServerCapabilities {
		return this.capabilities;
	}

	private async rpc<T>(
		method: string,
		params?: Record<string, unknown>,
		signal?: AbortSignal,
		timeoutOverrideMs?: number,
	): Promise<T> {
		const id = this.nextId++;
		const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
		const timeoutMs = timeoutOverrideMs ?? this.config.timeoutMs ?? 30_000;
		const response = await this.transport.request<T>(message, signal, timeoutMs);
		if (response.error) {
			throw new Error(`MCP ${this.name} ${method}: ${response.error.message} (code ${response.error.code})`);
		}
		if (response.result === undefined) {
			throw new Error(`MCP ${this.name} ${method}: response missing result`);
		}
		return response.result;
	}

	async initialize(signal?: AbortSignal): Promise<void> {
		// Refresh an expired OAuth token and re-inject the bearer before connecting,
		// so a reconnect after token expiry re-handshakes with a valid token.
		await this.ensureFreshAuth();
		this.transport.updateConfig?.(this.transportConfig());
		// start() resets/(re)opens the transport so a reconnect re-handshakes with
		// fresh state (no stale HTTP session id, no dead subprocess, no dead channel).
		await this.transport.start(signal);
		const result = await this.rpc<{
			serverInfo?: { name?: string; version?: string };
			protocolVersion?: string;
			capabilities?: Record<string, unknown>;
		}>(
			"initialize",
			{
				protocolVersion: PROTOCOL_VERSION,
				capabilities: { tools: {}, resources: {}, prompts: {} },
				clientInfo: CLIENT_INFO,
			},
			signal,
			15_000,
		);
		this.serverInfo = result.serverInfo;
		const caps = result.capabilities ?? {};
		this.capabilities = {
			tools: caps.tools !== undefined,
			resources: caps.resources !== undefined,
			prompts: caps.prompts !== undefined,
		};

		// Send the initialized notification (no response expected).
		await this.transport.notify({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);

		// Always refresh tools (servers commonly advertise tools without an explicit
		// capability flag; tools/list is harmless if empty). Resources/prompts are
		// only listed lazily, gated by their capability.
		await this.refreshTools(signal);
		this.initialized = true;
	}

	async refreshTools(signal?: AbortSignal): Promise<McpToolSchema[]> {
		// tools/list is paginated (MCP spec): follow nextCursor until exhausted so
		// servers with many tools aren't silently truncated to the first page.
		// PAGE_CAP bounds a server that returns a cursor forever; a repeated cursor
		// also breaks the loop (no forward progress).
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
		return this.rpc<McpCallToolResult>("tools/call", { name: toolName, arguments: args }, signal);
	}

	/** List resources (paginated, capped). Returns [] if the server has no resources capability. */
	async listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]> {
		if (!this.capabilities.resources) return [];
		const PAGE_CAP = 50;
		const collected: McpResourceDescriptor[] = [];
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < PAGE_CAP; page++) {
			const params: Record<string, unknown> = cursor === undefined ? {} : { cursor };
			const result = await this.rpc<{ resources?: McpResourceDescriptor[]; nextCursor?: string }>(
				"resources/list",
				params,
				signal,
			);
			if (Array.isArray(result.resources)) collected.push(...result.resources);
			const next = result.nextCursor;
			if (typeof next !== "string" || next.length === 0 || seenCursors.has(next)) break;
			seenCursors.add(next);
			cursor = next;
		}
		return collected;
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContents> {
		return this.rpc<McpResourceContents>("resources/read", { uri }, signal);
	}

	/** List prompts. Returns [] if the server has no prompts capability. */
	async listPrompts(signal?: AbortSignal): Promise<McpPromptDescriptor[]> {
		if (!this.capabilities.prompts) return [];
		const PAGE_CAP = 50;
		const collected: McpPromptDescriptor[] = [];
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < PAGE_CAP; page++) {
			const params: Record<string, unknown> = cursor === undefined ? {} : { cursor };
			const result = await this.rpc<{ prompts?: McpPromptDescriptor[]; nextCursor?: string }>(
				"prompts/list",
				params,
				signal,
			);
			if (Array.isArray(result.prompts)) collected.push(...result.prompts);
			const next = result.nextCursor;
			if (typeof next !== "string" || next.length === 0 || seenCursors.has(next)) break;
			seenCursors.add(next);
			cursor = next;
		}
		return collected;
	}

	async getPrompt(name: string, args: Record<string, string>, signal?: AbortSignal): Promise<McpGetPromptResult> {
		return this.rpc<McpGetPromptResult>("prompts/get", { name, arguments: args }, signal);
	}

	updateConfig(config: McpServerConfig): void {
		this.config = config;
		this.transport.updateConfig?.(this.transportConfig());
	}

	dispose(): void {
		this.initialized = false;
		this.tools = [];
		this.capabilities = {};
		this.transport.dispose();
	}
}

/** @deprecated Backward-compatible alias; the client is no longer HTTP-only. */
export const McpHttpClient = McpClient;
