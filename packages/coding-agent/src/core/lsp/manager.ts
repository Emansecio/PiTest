/**
 * Per-cwd LSP config cache, startup warm-up, and a session-scoped manager that
 * the tool reaches through a module singleton (the same pattern used by the
 * eval-kernel manager). Warming servers at session start avoids cold-start
 * latency on the first `lsp` call in interactive sessions.
 */

import { recordDiagnostic } from "@pit/ai";
import {
	clearLspBootFailureMemory,
	getOrCreateClient,
	setIdleTimeout,
	shutdownClientsForCwd,
	WARMUP_TIMEOUT_MS,
} from "./client.ts";
import { type LspConfig, loadConfig, readLspConfigSourceMtimes } from "./config.ts";
import { log } from "./internal.ts";
import type { ServerConfig } from "./types.ts";
import { clearDiagnosticsSilenceMemo } from "./utils.ts";

// =============================================================================
// Config Cache
// =============================================================================

interface CachedLspConfig {
	config: LspConfig;
	mtimes: Map<string, number | null>;
}

const configCache = new Map<string, CachedLspConfig>();

function mtimesEqual(a: Map<string, number | null>, b: Map<string, number | null>): boolean {
	if (a.size !== b.size) return false;
	for (const [key, value] of b) {
		if (a.get(key) !== value) return false;
	}
	return true;
}

/** Load + cache LSP config for a cwd, applying its idle-timeout setting. Reloads when any config source mtime changes. */
export function getConfig(cwd: string): LspConfig {
	const currentMtimes = readLspConfigSourceMtimes(cwd);
	const cached = configCache.get(cwd);
	if (cached && mtimesEqual(cached.mtimes, currentMtimes)) {
		return cached.config;
	}
	const config = loadConfig(cwd);
	setIdleTimeout(config.idleTimeoutMs);
	configCache.set(cwd, { config, mtimes: currentMtimes });
	return config;
}

/** Drop a cached config (e.g. when config files change or session settings reload). */
export function invalidateConfig(cwd: string): void {
	configCache.delete(cwd);
	// A config change can alter server commands/args/roots, so remembered boot
	// failures and silent-diagnostics markers keyed on the old shape are stale —
	// clear them so a reloaded config gets a clean spawn + full diagnostics wait.
	clearLspBootFailureMemory();
	clearDiagnosticsSilenceMemo();
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

/**
 * Publish the session LSP manager. Process-global singleton (same pattern as
 * chrome / eval-kernel). Overwriting a live manager without clearing first is a
 * hazard — concurrent sessions can steal each other's clients — so we record a
 * diagnostic when that happens. Dispose paths must only clear when `===`.
 */
export function setCurrentLspManager(manager: LspManager | undefined): void {
	if (manager !== undefined && currentManager !== undefined && currentManager !== manager) {
		recordDiagnostic({
			category: "lsp.manager-overwrite",
			level: "warn",
			source: "lsp.manager-overwrite",
			context: {
				note: `Replacing live LspManager (cwd=${currentManager.cwd}) with another (cwd=${manager.cwd})`,
				path: manager.cwd,
			},
		});
		log.warn("setCurrentLspManager overwrote a live manager", {
			previousCwd: currentManager.cwd,
			nextCwd: manager.cwd,
		});
	}
	currentManager = manager;
}

export function getCurrentLspManager(): LspManager | undefined {
	return currentManager;
}
