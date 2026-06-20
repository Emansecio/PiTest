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

import { resolveServerConfig, resolveServerConfigAsync } from "./config-files.ts";
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

/**
 * Whether a transport error is an HTTP 401 — the bearer was rejected at the auth
 * gate, BEFORE the request reached business logic. This is the only status for
 * which refreshing and re-sending the SAME call is safe: a 401 guarantees the call
 * never executed, so it cannot have applied a side effect. A 403 is deliberately
 * NOT included: many servers return 403 from inside tool execution (mid-operation
 * permission denial) after partial side effects, so re-sending a 403'd tools/call
 * could double-apply it — see callTool.
 */
function isUnauthorizedError(err: unknown): boolean {
	if (!(err instanceof McpTransportError)) return false;
	return /\bHTTP 401\b/.test(err.message);
}

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
	private capabilities: McpServerCapabilities = {};
	private tools: McpToolSchema[] = [];
	/** `Bearer <token>` from OAuth, injected when the server has no static Authorization header. */
	private authHeader?: string;
	/** Set by the manager: invoked after a runtime tools/list_changed re-list so tools get re-registered. */
	onToolsChanged?: () => void;
	private relistInFlight = false;
	/**
	 * Single-flight guard for forceTokenRefresh. Concurrent 401s (e.g. two tool calls
	 * in flight when the bearer expires server-side) must NOT each issue a parallel
	 * OAuth refresh: many servers rotate the refresh_token (single-use), so a second
	 * refresh reading the now-consumed token fails and can clobber the freshly stored
	 * one. Concurrent callers await this shared promise instead. Mirrors relistInFlight.
	 */
	private refreshInFlight?: Promise<boolean>;

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
		// Attach an existing OAuth token (remote servers only) so the first connect
		// is authenticated without a separate step.
		const token = config.url ? loadMcpToken(name) : undefined;
		if (token) this.authHeader = `Bearer ${token.accessToken}`;
		// Build the transport from the RAW config (no `!cmd` resolution here). This
		// keeps the ctor non-blocking: a slow `!cmd` would otherwise freeze the event
		// loop synchronously (spawnSync), and the McpManager ctor builds every client
		// synchronously, so N slow servers would stall boot by ~N×10s.
		//
		// INVARIANT (verified across all three transports): no transport reads
		// headers/env/command in its constructor — Stdio reads env only in start();
		// Http/Sse read headers only when sending. createTransport itself only uses
		// transport/command/url to infer the kind and validate presence, and a raw
		// `${VAR}`/`!cmd` string is still a non-empty value for that check. initialize()
		// always re-resolves via updateConfig(await transportConfigAsync()) BEFORE
		// start(), so `!cmd` is resolved async before the first byte is sent.
		this.transport = createTransport(name, config);
		// Receive server-initiated notifications (persistent transports only).
		this.transport.onNotification = (method) => this.handleNotification(method);
	}

	/**
	 * React to a server list-changed notification by re-listing at runtime — no
	 * reconnect needed. A tools change re-lists and asks the host to re-register
	 * (new tools become callable). The in-flight guard collapses a burst of
	 * notifications into one refresh.
	 */
	private handleNotification(method: string): void {
		if (method === "notifications/tools/list_changed") {
			void this.relistTools();
		}
	}

	private async relistTools(): Promise<void> {
		if (this.relistInFlight) return;
		this.relistInFlight = true;
		try {
			await this.refreshTools();
			this.onToolsChanged?.();
		} catch {
			// Best-effort: a failed re-list leaves the prior catalog in place.
		} finally {
			this.relistInFlight = false;
		}
	}

	/** Whether the user configured a static Authorization header (which takes precedence over OAuth). */
	private hasStaticAuth(): boolean {
		return Object.keys(this.config.headers ?? {}).some((k) => k.toLowerCase() === "authorization");
	}

	/** Merge the OAuth bearer into a resolved config's headers when there's no static Authorization. */
	private mergeAuthHeader(resolved: McpServerConfig): McpServerConfig {
		if (this.authHeader && !this.hasStaticAuth()) {
			resolved.headers = { ...(resolved.headers ?? {}), Authorization: this.authHeader };
		}
		return resolved;
	}

	/** Resolved config for the transport, with the OAuth bearer merged in when applicable. */
	private transportConfig(): McpServerConfig {
		return this.mergeAuthHeader(resolveServerConfig(this.config));
	}

	/**
	 * Async, non-blocking variant of transportConfig used on the connect/reconnect
	 * paths (initialize / forceTokenRefresh). Resolves `!cmd` values via the
	 * non-blocking resolver so a slow command yields the event loop instead of
	 * freezing it, then merges the OAuth bearer with the same precedence as the
	 * sync version.
	 */
	private async transportConfigAsync(): Promise<McpServerConfig> {
		return this.mergeAuthHeader(await resolveServerConfigAsync(this.config));
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

	/**
	 * Force an OAuth refresh regardless of the stored expiry — used when the server
	 * answers 401 (the token was revoked/rotated server-side, or had no `expires_in`
	 * so `isTokenExpired` couldn't predict it). Re-injects the new bearer into the
	 * transport. Returns true only if a fresh token was obtained.
	 *
	 * Single-flighted: concurrent callers (e.g. two tool calls that both 401 when the
	 * bearer expires server-side) await the same in-flight refresh rather than issuing
	 * parallel refreshMcpToken calls, which would consume a single-use refresh_token
	 * twice and lose the freshly stored token.
	 */
	private forceTokenRefresh(): Promise<boolean> {
		if (this.refreshInFlight) return this.refreshInFlight;
		const inFlight = this.doForceTokenRefresh().finally(() => {
			this.refreshInFlight = undefined;
		});
		this.refreshInFlight = inFlight;
		return inFlight;
	}

	private async doForceTokenRefresh(): Promise<boolean> {
		if (!this.config.url || this.hasStaticAuth()) return false;
		const refreshed = await refreshMcpToken(this.name);
		if (!refreshed) return false;
		this.authHeader = `Bearer ${refreshed.accessToken}`;
		this.transport.updateConfig?.(await this.transportConfigAsync());
		return true;
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
		this.transport.updateConfig?.(await this.transportConfigAsync());
		// start() resets/(re)opens the transport so a reconnect re-handshakes with
		// fresh state (no stale HTTP session id, no dead subprocess, no dead channel).
		await this.transport.start(signal);
		const initParams = {
			protocolVersion: PROTOCOL_VERSION,
			capabilities: { tools: {}, resources: {}, prompts: {} },
			clientInfo: CLIENT_INFO,
		};
		type InitResult = {
			protocolVersion?: string;
			capabilities?: Record<string, unknown>;
		};
		let result: InitResult;
		try {
			result = await this.rpc<InitResult>("initialize", initParams, signal, 15_000);
		} catch (err) {
			// Stored token rejected at handshake (revoked/rotated, or no expiry to
			// pre-refresh): force a refresh and re-handshake once.
			if (isUnauthorizedError(err) && (await this.forceTokenRefresh())) {
				result = await this.rpc<InitResult>("initialize", initParams, signal, 15_000);
			} else {
				throw err;
			}
		}
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

	/**
	 * Drive a paginated list method (tools/resources/prompts): follow nextCursor
	 * until exhausted so a server with many entries isn't silently truncated to the
	 * first page. PAGE_CAP bounds a server that returns a cursor forever; a repeated
	 * cursor also breaks the loop (no forward progress). `pick` extracts the array
	 * from each page's result.
	 */
	private async paginate<TItem, TResult>(
		method: string,
		pick: (result: TResult) => TItem[] | undefined,
		signal?: AbortSignal,
	): Promise<TItem[]> {
		const PAGE_CAP = 50;
		const collected: TItem[] = [];
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < PAGE_CAP; page++) {
			const params: Record<string, unknown> = cursor === undefined ? {} : { cursor };
			const result = await this.rpc<TResult & { nextCursor?: string }>(method, params, signal);
			const items = pick(result);
			if (Array.isArray(items)) collected.push(...items);
			const next = result.nextCursor;
			if (typeof next !== "string" || next.length === 0 || seenCursors.has(next)) break;
			seenCursors.add(next);
			cursor = next;
		}
		return collected;
	}

	async refreshTools(signal?: AbortSignal): Promise<McpToolSchema[]> {
		this.tools = await this.paginate<McpToolSchema, McpListToolsResult>(
			"tools/list",
			(result) => result.tools,
			signal,
		);
		return this.tools;
	}

	async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallToolResult> {
		const params = { name: toolName, arguments: args };
		try {
			return await this.rpc<McpCallToolResult>("tools/call", params, signal);
		} catch (err) {
			// A 401 means the OAuth bearer was rejected at the auth gate (revoked/rotated,
			// or it never had an expiry so we couldn't refresh proactively): the call
			// never reached business logic, so refreshing once and re-sending the SAME
			// call is side-effect-safe. isUnauthorizedError matches 401 ONLY — a 403 may
			// be a mid-operation permission denial after partial side effects, so it is
			// surfaced without resend to avoid double-applying a side-effecting tool.
			if (isUnauthorizedError(err) && (await this.forceTokenRefresh())) {
				return await this.rpc<McpCallToolResult>("tools/call", params, signal);
			}
			throw err;
		}
	}

	/** List resources (paginated, capped). Returns [] if the server has no resources capability. */
	async listResources(signal?: AbortSignal): Promise<McpResourceDescriptor[]> {
		if (!this.capabilities.resources) return [];
		return this.paginate<McpResourceDescriptor, { resources?: McpResourceDescriptor[] }>(
			"resources/list",
			(result) => result.resources,
			signal,
		);
	}

	async readResource(uri: string, signal?: AbortSignal): Promise<McpResourceContents> {
		return this.rpc<McpResourceContents>("resources/read", { uri }, signal);
	}

	/** List prompts. Returns [] if the server has no prompts capability. */
	async listPrompts(signal?: AbortSignal): Promise<McpPromptDescriptor[]> {
		if (!this.capabilities.prompts) return [];
		return this.paginate<McpPromptDescriptor, { prompts?: McpPromptDescriptor[] }>(
			"prompts/list",
			(result) => result.prompts,
			signal,
		);
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
