/**
 * McpManager — owns a pool of McpClient instances, handles connect /
 * reconnect / disconnect, and exposes the set of currently advertised tools
 * across all servers.
 *
 * Reconnect strategy: when a `callTool` fails with a TRANSPORT error (network,
 * HTTP status, malformed payload — `McpTransportError`), the manager marks the
 * server disconnected and re-runs `initialize` once so the NEXT call finds a
 * live session. The failed call itself is never re-sent: tool calls may have
 * side effects, and a timed-out call may already have been applied server-side.
 * JSON-RPC application errors and user aborts leave connection state untouched
 * (the server is alive and answering). A direct success resets the entry back
 * to healthy. Background polling is intentionally absent — pi is interactive,
 * so a failed call surfaces immediately and re-connect happens lazily.
 */

import { McpClient, McpTransportError } from "./client.ts";
import type { McpCallToolResult, McpConnectionState, McpServerConfig, McpToolSchema } from "./types.ts";

/** Display label for a server: its endpoint URL (http/sse) or launch command (stdio). */
function serverDisplayTarget(config: McpServerConfig): string {
	if (config.url) return config.url;
	if (config.command) return [config.command, ...(config.args ?? [])].join(" ");
	return "(unconfigured)";
}

export interface McpManagerOptions {
	servers: Record<string, McpServerConfig>;
	/** Callback invoked when a server's state changes (connected, disconnected, error). */
	onStateChange?: (state: McpConnectionState) => void;
	/** Invoked when a server re-listed its tools at runtime (tools/list_changed) so the host can re-register. */
	onToolsChanged?: (serverName: string) => void;
	/** Max consecutive reconnect attempts per call. Default: 1. */
	maxReconnectAttempts?: number;
}

interface ServerEntry {
	name: string;
	config: McpServerConfig;
	client: McpClient;
	connected: boolean;
	lastError?: string;
	reconnectAttempts: number;
}

export class McpManager {
	private entries = new Map<string, ServerEntry>();
	private onStateChange?: (state: McpConnectionState) => void;
	private onToolsChanged?: (serverName: string) => void;
	private maxReconnectAttempts: number;
	private disposed = false;

	constructor(options: McpManagerOptions) {
		this.onStateChange = options.onStateChange;
		this.onToolsChanged = options.onToolsChanged;
		this.maxReconnectAttempts = options.maxReconnectAttempts ?? 1;
		for (const [name, config] of Object.entries(options.servers)) {
			if (config.disabled) continue;
			const client = new McpClient(name, config);
			// Runtime tools/list_changed → host re-registers the (possibly new) tools.
			client.onToolsChanged = () => this.onToolsChanged?.(name);
			this.entries.set(name, {
				name,
				config,
				client,
				connected: false,
				reconnectAttempts: 0,
			});
		}
	}

	get serverNames(): string[] {
		return [...this.entries.keys()];
	}

	getState(name: string): McpConnectionState | undefined {
		const entry = this.entries.get(name);
		if (!entry) return undefined;
		return {
			name: entry.name,
			url: serverDisplayTarget(entry.config),
			connected: entry.connected,
			lastError: entry.lastError,
			tools: entry.client.getTools(),
			reconnectAttempts: entry.reconnectAttempts,
		};
	}

	getAllStates(): McpConnectionState[] {
		return [...this.entries.keys()].map((name) => this.getState(name)!).filter(Boolean);
	}

	/** The live client for a connected server (for resources/prompts access). */
	getClient(name: string): McpClient | undefined {
		const entry = this.entries.get(name);
		return entry?.connected ? entry.client : undefined;
	}

	/** Names + clients of every currently connected server. */
	connectedClients(): Array<{ name: string; client: McpClient }> {
		const out: Array<{ name: string; client: McpClient }> = [];
		for (const entry of this.entries.values()) {
			if (entry.connected) out.push({ name: entry.name, client: entry.client });
		}
		return out;
	}

	/** Resolve a configured server's tool prefix (public for prompt/resource naming). */
	prefixFor(name: string): string | undefined {
		const entry = this.entries.get(name);
		return entry ? this.toolPrefixFor(entry) : undefined;
	}

	private emit(entry: ServerEntry) {
		// getState returns undefined once the entry is gone (dispose() clears the
		// map). connectAll/callTool capture `entry` and emit AFTER awaits, so a
		// dispose racing an in-flight initialize would otherwise pass undefined to
		// onStateChange, crashing consumers that read `state.connected`. Skip the
		// emit when the state has been disposed out from under us.
		const state = this.getState(entry.name);
		if (!state) return;
		this.onStateChange?.(state);
	}

	private isAllowedTool(entry: ServerEntry, toolName: string): boolean {
		if (entry.config.denyTools?.includes(toolName)) return false;
		if (entry.config.allowTools && !entry.config.allowTools.includes(toolName)) return false;
		return true;
	}

	/** Connect every server in parallel; failures are recorded per-server, not thrown. */
	async connectAll(signal?: AbortSignal): Promise<void> {
		await Promise.all(
			[...this.entries.values()].map(async (entry) => {
				try {
					await entry.client.initialize(signal);
					entry.connected = true;
					entry.lastError = undefined;
					entry.reconnectAttempts = 0;
				} catch (err) {
					entry.connected = false;
					entry.lastError = err instanceof Error ? err.message : String(err);
				}
				this.emit(entry);
			}),
		);
	}

	// Default prefix follows the ecosystem-wide `mcp__<server>__<tool>` naming
	// (Claude Code et al.). Downstream heuristics depend on it: compaction's
	// extractFileOpsFromMessage detects MCP calls via the `mcp__` prefix, so a
	// bare `<server>__` default would make MCP work invisible in branch
	// summaries. Users can still override per server via `toolPrefix`.
	private toolPrefixFor(entry: ServerEntry): string {
		return entry.config.toolPrefix ?? `mcp__${entry.name}__`;
	}

	/** Returns prefixed tools across all connected servers. */
	listTools(): Array<{ serverName: string; prefixedName: string; schema: McpToolSchema }> {
		const out: Array<{ serverName: string; prefixedName: string; schema: McpToolSchema }> = [];
		for (const entry of this.entries.values()) {
			if (!entry.connected) continue;
			const prefix = this.toolPrefixFor(entry);
			for (const tool of entry.client.getTools()) {
				if (!this.isAllowedTool(entry, tool.name)) continue;
				out.push({
					serverName: entry.name,
					prefixedName: `${prefix}${tool.name}`,
					schema: tool,
				});
			}
		}
		return out;
	}

	/** Call a tool by its prefixed name. */
	async callTool(
		prefixedName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<McpCallToolResult> {
		const dispatch = this.resolveDispatch(prefixedName);
		if (!dispatch) {
			throw new Error(`MCP tool "${prefixedName}" not found`);
		}
		const { entry, originalName } = dispatch;

		try {
			const result = await entry.client.callTool(originalName, args, signal);
			// A direct success proves the server healthy: clear any degraded state
			// left by an earlier transport failure so future failures get their
			// reconnect attempt back. Emit only on an actual transition.
			if (!entry.connected || entry.reconnectAttempts > 0 || entry.lastError !== undefined) {
				entry.connected = true;
				entry.lastError = undefined;
				entry.reconnectAttempts = 0;
				this.emit(entry);
			}
			return result;
		} catch (err) {
			// A user abort is not a server fault: leave connection state untouched.
			if (signal?.aborted) {
				throw err;
			}
			entry.lastError = err instanceof Error ? err.message : String(err);
			if (!(err instanceof McpTransportError)) {
				// JSON-RPC application error: the server is alive and answering.
				this.emit(entry);
				throw err;
			}
			entry.connected = false;
			this.emit(entry);
			// Re-initialize so the NEXT call finds a live session, then propagate
			// the original failure. The call is never re-sent: it may have side
			// effects, and a timed-out call may already have been applied.
			if (entry.reconnectAttempts < this.maxReconnectAttempts) {
				entry.reconnectAttempts++;
				try {
					await entry.client.initialize(signal);
					entry.connected = true;
					entry.lastError = undefined;
					entry.reconnectAttempts = 0;
				} catch (reconnectErr) {
					entry.lastError = reconnectErr instanceof Error ? reconnectErr.message : String(reconnectErr);
				}
				this.emit(entry);
			}
			throw err;
		}
	}

	private resolveDispatch(prefixedName: string): { entry: ServerEntry; originalName: string } | undefined {
		for (const entry of this.entries.values()) {
			const prefix = this.toolPrefixFor(entry);
			if (!prefixedName.startsWith(prefix)) continue;
			const originalName = prefixedName.slice(prefix.length);
			if (!this.isAllowedTool(entry, originalName)) continue;
			if (entry.client.getTools().some((t) => t.name === originalName)) {
				return { entry, originalName };
			}
		}
		return undefined;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const entry of this.entries.values()) {
			entry.client.dispose();
		}
		this.entries.clear();
	}
}
