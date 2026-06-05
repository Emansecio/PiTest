/**
 * Per-cwd LSP config cache, startup warm-up, and a session-scoped manager that
 * the tool reaches through a module singleton (the same pattern used by the
 * eval-kernel manager). Warming servers at session start avoids cold-start
 * latency on the first `lsp` call in interactive sessions.
 */

import { getOrCreateClient, setIdleTimeout, shutdownClientsForCwd, WARMUP_TIMEOUT_MS } from "./client.ts";
import { type LspConfig, loadConfig } from "./config.ts";
import { log } from "./internal.ts";
import type { ServerConfig } from "./types.ts";

// =============================================================================
// Config Cache
// =============================================================================

const configCache = new Map<string, LspConfig>();

/** Load + cache LSP config for a cwd, applying its idle-timeout setting. */
export function getConfig(cwd: string): LspConfig {
	let config = configCache.get(cwd);
	if (!config) {
		config = loadConfig(cwd);
		setIdleTimeout(config.idleTimeoutMs);
		configCache.set(cwd, config);
	}
	return config;
}

/** Drop a cached config (e.g. when config files change). */
export function invalidateConfig(cwd: string): void {
	configCache.delete(cwd);
}

// =============================================================================
// Server Selection (no custom linters in this build → "lsp servers" = all)
// =============================================================================

export function getLspServers(config: LspConfig): Array<[string, ServerConfig]> {
	return Object.entries(config.servers) as Array<[string, ServerConfig]>;
}

export function isProjectAwareLspServer(serverConfig: ServerConfig): boolean {
	return !serverConfig.isLinter;
}

// =============================================================================
// Startup Discovery / Warm-up
// =============================================================================

export interface LspStartupServerInfo {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	error?: string;
}

export interface LspWarmupResult {
	servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
}

export interface LspWarmupOptions {
	onConnecting?: (serverNames: string[]) => void;
}

/** Start all detected servers in parallel with a short per-server timeout. */
export async function warmupLspServers(cwd: string, options?: LspWarmupOptions): Promise<LspWarmupResult> {
	const config = getConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	const servers: LspWarmupResult["servers"] = [];
	const lspServers = getLspServers(config);

	if (lspServers.length > 0 && options?.onConnecting) {
		options.onConnecting(lspServers.map(([name]) => name));
	}

	const results = await Promise.allSettled(
		lspServers.map(async ([name, serverConfig]) => {
			const client = await getOrCreateClient(serverConfig, cwd, serverConfig.warmupTimeoutMs ?? WARMUP_TIMEOUT_MS);
			return { name, client, fileTypes: serverConfig.fileTypes };
		}),
	);

	for (let i = 0; i < results.length; i++) {
		const result = results[i];
		const [name, serverConfig] = lspServers[i];
		if (result.status === "fulfilled") {
			servers.push({ name: result.value.name, status: "ready", fileTypes: result.value.fileTypes });
		} else {
			const errorMsg = result.reason?.message ?? String(result.reason);
			log.warn("LSP server failed to start", { server: name, error: errorMsg });
			servers.push({ name, status: "error", fileTypes: serverConfig.fileTypes, error: errorMsg });
		}
	}
	return { servers };
}

// =============================================================================
// Session-scoped Manager + Singleton
// =============================================================================

export interface LspManager {
	readonly cwd: string;
	/** Warm up detected servers; safe to call once at session start. */
	warmup(options?: LspWarmupOptions): Promise<LspWarmupResult>;
	/** Shut down the servers rooted at this cwd. */
	dispose(): Promise<void>;
}

class LspManagerImpl implements LspManager {
	private warmed = false;
	readonly cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async warmup(options?: LspWarmupOptions): Promise<LspWarmupResult> {
		if (this.warmed) return { servers: [] };
		this.warmed = true;
		return warmupLspServers(this.cwd, options);
	}

	async dispose(): Promise<void> {
		invalidateConfig(this.cwd);
		await shutdownClientsForCwd(this.cwd);
	}
}

export function createLspManager(cwd: string): LspManager {
	return new LspManagerImpl(cwd);
}

let currentManager: LspManager | undefined;

export function setCurrentLspManager(manager: LspManager | undefined): void {
	currentManager = manager;
}

export function getCurrentLspManager(): LspManager | undefined {
	return currentManager;
}
