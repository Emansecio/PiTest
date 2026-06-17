/**
 * Transport factory: pick the wire transport for a server config.
 *
 * Inference (when `transport` is unset): a `command` means a local subprocess
 * (stdio); otherwise a `url` means HTTP (Streamable, default). The legacy
 * HTTP+SSE transport is opt-in via `transport: "sse"`.
 */

import type { McpServerConfig } from "../types.ts";
import { HttpTransport } from "./http.ts";
import { SseTransport } from "./sse.ts";
import { StdioTransport } from "./stdio.ts";
import { type McpTransport, McpTransportError } from "./types.ts";

export type McpTransportKind = "http" | "sse" | "stdio";

export function inferTransportKind(config: McpServerConfig): McpTransportKind {
	if (config.transport) return config.transport;
	if (config.command) return "stdio";
	return "http";
}

export function createTransport(name: string, config: McpServerConfig): McpTransport {
	const kind = inferTransportKind(config);
	if (kind === "stdio") {
		if (!config.command) throw new McpTransportError(`MCP ${name}: stdio transport requires a "command"`);
		return new StdioTransport(name, config);
	}
	if (!config.url) throw new McpTransportError(`MCP ${name}: ${kind} transport requires a "url"`);
	return kind === "sse" ? new SseTransport(name, config) : new HttpTransport(name, config);
}

export { HttpTransport } from "./http.ts";
export { SseTransport } from "./sse.ts";
export { StdioTransport } from "./stdio.ts";
export {
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type McpTransport,
	McpTransportError,
} from "./types.ts";
