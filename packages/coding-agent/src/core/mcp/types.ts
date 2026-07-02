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
	/**
	 * Wire transport. Usually inferred and omitted: a `command` implies `"stdio"`,
	 * otherwise a `url` implies `"http"` (Streamable HTTP). Set `"sse"` explicitly
	 * for the legacy HTTP+SSE transport.
	 */
	transport?: "http" | "sse" | "stdio";
	/** Endpoint URL. Required for http/sse transports. */
	url?: string;
	/** Executable to launch for the stdio transport (local subprocess MCP server). */
	command?: string;
	/** Arguments passed to `command` (stdio transport). */
	args?: string[];
	/** Extra environment variables for the stdio subprocess (merged over the inherited env). */
	env?: Record<string, string>;
	/** Working directory for the stdio subprocess. Default: process cwd. */
	cwd?: string;
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
	/**
	 * OAuth 2.0 settings for a remote (http/sse) server that requires browser-flow
	 * auth. When present, the manager attaches a bearer token (obtained via
	 * `pit mcp authenticate`) and refreshes it on 401. Static `headers` still win
	 * if both are set.
	 */
	oauth?: McpOAuthConfig;
}

export interface McpOAuthConfig {
	/** Pre-registered client id (skips Dynamic Client Registration if set). */
	clientId?: string;
	/** Pre-registered client secret (confidential clients). */
	clientSecret?: string;
	/** Explicit authorization-server metadata URL (skips discovery if set). */
	authorizationServerUrl?: string;
	/** OAuth scopes to request. */
	scopes?: string[];
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
	/**
	 * Wall-clock budget (ms) for the startup connect pass before a still-connecting
	 * server is skipped (it reconnects on demand later). Default 10000. Raise it for
	 * slow network/SSH-tunneled servers so they are not silently dropped at boot.
	 */
	connectTimeoutMs?: number;
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
	/**
	 * Structured tool output (MCP spec 2025-06-18). Servers that declare an
	 * `outputSchema` may return only `structuredContent` and omit `content[]`.
	 */
	structuredContent?: unknown;
	isError?: boolean;
}

/** Server capabilities reported by the initialize handshake. */
export interface McpServerCapabilities {
	tools?: boolean;
	resources?: boolean;
	prompts?: boolean;
}

export interface McpResourceDescriptor {
	uri: string;
	name?: string;
	description?: string;
	mimeType?: string;
}

export interface McpResourceContents {
	contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string }>;
}

export interface McpPromptArgument {
	name: string;
	description?: string;
	required?: boolean;
}

export interface McpPromptDescriptor {
	name: string;
	description?: string;
	arguments?: McpPromptArgument[];
}

export interface McpPromptMessage {
	role: "user" | "assistant";
	content:
		| { type: "text"; text: string }
		| { type: "image"; data: string; mimeType: string }
		| { type: "resource"; resource: { uri: string; mimeType?: string; text?: string } };
}

export interface McpGetPromptResult {
	description?: string;
	messages: McpPromptMessage[];
}

export interface McpConnectionState {
	name: string;
	/** Endpoint URL (http/sse) or the launch command (stdio), for display. */
	url: string;
	connected: boolean;
	/** Turned off at runtime (or via `disabled` in config): keeps its entry but never connects. */
	disabled: boolean;
	lastError?: string;
	tools: McpToolSchema[];
	reconnectAttempts: number;
}
