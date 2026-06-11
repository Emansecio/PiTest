/**
 * MCP (Model Context Protocol) settings and types.
 *
 * Pi supports MCP-over-HTTP transport: each server is reachable at a JSON-RPC
 * 2.0 endpoint accepting POST requests with `Content-Type: application/json`.
 *
 * Note: the official MCP spec also defines stdio and SSE transports. Pi
 * currently ships only the HTTP transport. The wire format is identical to
 * the spec's JSON-RPC envelope so users with HTTP-compatible MCP servers can
 * point Pi at them without modification.
 */

export interface McpServerConfig {
	/** Endpoint URL. Required. */
	url: string;
	/** Optional request headers (e.g. `{ Authorization: "Bearer ${MY_TOKEN}" }`). */
	headers?: Record<string, string>;
	/** Per-request timeout in ms. Default: 30000. */
	timeoutMs?: number;
	/** Disable this server without removing it from settings. */
	disabled?: boolean;
	/** Optional allowlist of tool names to expose (defaults to all). */
	allowTools?: string[];
	/** Optional denylist of tool names to hide. */
	denyTools?: string[];
	/** Optional prefix added to tool names to avoid conflicts. Default: `mcp__<server>__`. */
	toolPrefix?: string;
	/**
	 * Per-server override of the deferral decision (see `McpSettings.defer`).
	 * `true` always defers this server's tools off the active surface (model finds
	 * them via search_tool_bm25); `false` always keeps them eager. Unset → follows
	 * the global `defer` policy.
	 */
	defer?: boolean;
}

export interface McpSettings {
	servers?: Record<string, McpServerConfig>;
	/**
	 * How aggressively to keep MCP tool schemas OFF the active tool surface (each
	 * active tool's full JSON Schema is re-sent to the model every turn, so a
	 * grab-bag server like Notion/Chrome is a large, permanent token cost and a
	 * cache-prefix destabilizer). Deferred tools live in the tool-discovery index
	 * and are pulled in on demand via `search_tool_bm25`.
	 * - `"auto"` (default): defer a server only when it advertises at least
	 *   `deferThreshold` tools; small focused servers stay eager (immediately
	 *   callable, no discovery round-trip).
	 * - `"always"`: defer every server.
	 * - `"never"`: register every server's tools eagerly (legacy behavior).
	 * Requires tool discovery to be enabled; with it off, tools are always eager.
	 * The legacy env `PIT_DEFER_MCP` (truthy: 1/true/yes) forces `"always"`.
	 */
	defer?: "auto" | "always" | "never";
	/** Tool-count threshold for `defer: "auto"` (default 10). A server with this many tools or more is deferred. */
	deferThreshold?: number;
}

export interface McpToolSchema {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
}

export interface McpListToolsResult {
	tools: McpToolSchema[];
	/** Opaque pagination cursor; when present, more tools remain (MCP spec). */
	nextCursor?: string;
}

export interface McpCallToolResult {
	content: Array<
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
		| { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } }
	>;
	isError?: boolean;
}

export interface McpConnectionState {
	name: string;
	url: string;
	connected: boolean;
	lastError?: string;
	tools: McpToolSchema[];
	reconnectAttempts: number;
}
