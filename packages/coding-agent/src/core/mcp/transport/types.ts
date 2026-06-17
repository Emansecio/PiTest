/**
 * Transport abstraction for MCP.
 *
 * The MCP wire format is JSON-RPC 2.0 regardless of how bytes move (HTTP POST,
 * a long-lived stdio pipe, or an SSE event channel). `McpClient` owns the
 * JSON-RPC layer — id allocation, result/error unwrapping, the initialize
 * handshake, tools/resources/prompts methods — and delegates byte delivery to
 * an `McpTransport`. Each transport implementation is responsible only for
 * getting a request out and the matching response back (correlating by id where
 * the channel is multiplexed), plus its own framing, timeouts, and lifecycle.
 */

import type { McpServerConfig } from "../types.ts";

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: number | string;
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: Record<string, unknown>;
}

export interface JsonRpcResponse<T = unknown> {
	jsonrpc: "2.0";
	id: number | string;
	result?: T;
	error?: { code: number; message: string; data?: unknown };
}

/**
 * Transport-level failure (network error, HTTP status, spawn failure, broken
 * pipe, malformed/oversized payload) as opposed to a JSON-RPC application error
 * returned by a live server. The manager only marks a server disconnected — and
 * re-initializes — for these; application errors leave the connection untouched.
 */
export class McpTransportError extends Error {}

export interface McpTransport {
	/**
	 * Bring the transport up so requests can flow: spawn the subprocess (stdio),
	 * open the event channel (sse), or reset session state (http). Called at the
	 * start of every `initialize`, so a reconnect re-runs it — implementations
	 * must make it idempotent / fresh (kill a stale process, drop a dead session).
	 */
	start(signal?: AbortSignal): Promise<void>;
	/** Send a request and resolve with the matching JSON-RPC response envelope. */
	request<T = unknown>(message: JsonRpcRequest, signal?: AbortSignal, timeoutMs?: number): Promise<JsonRpcResponse<T>>;
	/** Fire a notification (no response expected). Failures are non-fatal. */
	notify(message: JsonRpcNotification, signal?: AbortSignal): Promise<void>;
	/** Swap the (already env-resolved) config — used to inject a refreshed OAuth bearer before reconnect. */
	updateConfig?(config: McpServerConfig): void;
	/** Tear down: kill the subprocess (stdio), close the channel (sse), clear session (http). */
	dispose(): void;
}
