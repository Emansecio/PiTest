/**
 * McpManager — owns a pool of McpHttpClient instances, handles connect /
 * reconnect / disconnect, and exposes the set of currently advertised tools
 * across all servers.
 *
 * Reconnect strategy: when a `callTool` fails with a network-class error,
 * the manager re-runs `initialize` once. If that succeeds it retries the
 * original call; if it fails the original error is propagated. Background
 * polling is intentionally absent — pi is interactive, so a failed call
 * surfaces immediately and re-connect happens lazily on next attempt.
 */

import { McpHttpClient } from "./client.ts";
import type { McpCallToolResult, McpConnectionState, McpServerConfig, McpToolSchema } from "./types.ts";

export interface McpManagerOptions {
	servers: Record<string, McpServerConfig>;
	/** Callback invoked when a server's state changes (connected, disconnected, error). */
	onStateChange?: (state: McpConnectionState) => void;
	/** Max consecutive reconnect attempts per call. Default: 1. */
	maxReconnectAttempts?: number;
}

interface ServerEntry {
	name: string;
	config: McpServerConfig;
	client: McpHttpClient;
	connected: boolean;
	lastError?: string;
	reconnectAttempts: number;
}

export class McpManager {
	private entries = new Map<string, ServerEntry>();
	private onStateChange?: (state: McpConnectionState) => void;
	private maxReconnectAttempts: number;
	private disposed = false;

	constructor(options: McpManagerOptions) {
		this.onStateChange = options.onStateChange;
		this.maxReconnectAttempts = options.maxReconnectAttempts ?? 1;
		for (const [name, config] of Object.entries(options.servers)) {
			if (config.disabled) continue;
			this.entries.set(name, {
				name,
				config,
				client: new McpHttpClient(name, config),
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
			url: entry.config.url,
			connected: entry.connected,
			lastError: entry.lastError,
			tools: entry.client.getTools(),
			reconnectAttempts: entry.reconnectAttempts,
		};
	}

	getAllStates(): McpConnectionState[] {
		return [...this.entries.keys()].map((name) => this.getState(name)!).filter(Boolean);
	}

	private emit(entry: ServerEntry) {
		this.onStateChange?.(this.getState(entry.name)!);
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
				} catch (err) {
					entry.connected = false;
					entry.lastError = err instanceof Error ? err.message : String(err);
				}
				this.emit(entry);
			}),
		);
	}

	/** Returns prefixed tools across all connected servers. */
	listTools(): Array<{ serverName: string; prefixedName: string; schema: McpToolSchema }> {
		const out: Array<{ serverName: string; prefixedName: string; schema: McpToolSchema }> = [];
		for (const entry of this.entries.values()) {
			if (!entry.connected) continue;
			const prefix = entry.config.toolPrefix ?? `${entry.name}__`;
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
			return await entry.client.callTool(originalName, args, signal);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			entry.lastError = message;
			entry.connected = false;
			this.emit(entry);

			if (entry.reconnectAttempts >= this.maxReconnectAttempts) {
				throw err;
			}

			entry.reconnectAttempts++;
			try {
				await entry.client.initialize(signal);
				entry.connected = true;
				entry.lastError = undefined;
				this.emit(entry);
				const result = await entry.client.callTool(originalName, args, signal);
				entry.reconnectAttempts = 0;
				return result;
			} catch (retryErr) {
				entry.lastError = retryErr instanceof Error ? retryErr.message : String(retryErr);
				this.emit(entry);
				throw retryErr;
			}
		}
	}

	private resolveDispatch(prefixedName: string): { entry: ServerEntry; originalName: string } | undefined {
		for (const entry of this.entries.values()) {
			const prefix = entry.config.toolPrefix ?? `${entry.name}__`;
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
