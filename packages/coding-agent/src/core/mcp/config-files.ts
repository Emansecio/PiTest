/**
 * Versioned MCP config files + scope merging + env resolution.
 *
 * Beyond `settings.json` (`mcp.servers`), Pit reads three files, matching the
 * Claude Code scope model so `.mcp.json` configs import cleanly:
 *  - `<agentDir>/mcp.json` — user scope, personal across all projects.
 *  - `<cwd>/.mcp.json`     — project scope, committed/shared (CC `{ mcpServers: {} }`).
 *  - `<cwd>/.mcp.local.json` — local scope, gitignored, personal per-project overrides.
 *
 * Server precedence (weakest → strongest):
 *   global settings.json → user mcp.json → project .mcp.json → project settings.json → .mcp.local.json
 * (local overrides everything; project settings override the shared .mcp.json;
 * user file overrides global settings). `defer`/`deferThreshold` top-level policy
 * comes from settings (project preferred over global).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	interpolateEnvVars,
	resolveConfigValueUncached,
	resolveConfigValueUncachedAsync,
} from "../resolve-config-value.ts";
import type { McpServerConfig, McpSettings } from "./types.ts";

/** Raw shape of a `.mcp.json` entry (Claude Code uses `type` for the transport). */
interface RawServerEntry {
	type?: "http" | "sse" | "stdio";
	transport?: "http" | "sse" | "stdio";
	url?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	disabled?: boolean;
	allowTools?: string[];
	denyTools?: string[];
	toolPrefix?: string;
	defer?: boolean;
	oauth?: McpServerConfig["oauth"];
}

function normalizeServerEntry(raw: RawServerEntry): McpServerConfig {
	const transport = raw.transport ?? raw.type;
	const cfg: McpServerConfig = {};
	if (transport) cfg.transport = transport;
	if (raw.url !== undefined) cfg.url = raw.url;
	if (raw.command !== undefined) cfg.command = raw.command;
	if (raw.args !== undefined) cfg.args = raw.args;
	if (raw.env !== undefined) cfg.env = raw.env;
	if (raw.cwd !== undefined) cfg.cwd = raw.cwd;
	if (raw.headers !== undefined) cfg.headers = raw.headers;
	if (raw.timeoutMs !== undefined) cfg.timeoutMs = raw.timeoutMs;
	if (raw.disabled !== undefined) cfg.disabled = raw.disabled;
	if (raw.allowTools !== undefined) cfg.allowTools = raw.allowTools;
	if (raw.denyTools !== undefined) cfg.denyTools = raw.denyTools;
	if (raw.toolPrefix !== undefined) cfg.toolPrefix = raw.toolPrefix;
	if (raw.defer !== undefined) cfg.defer = raw.defer;
	if (raw.oauth !== undefined) cfg.oauth = raw.oauth;
	return cfg;
}

/** Read one config file; returns {} on missing file or parse error (logged). */
export function loadMcpConfigFile(path: string): Record<string, McpServerConfig> {
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return {}; // missing file is normal
	}
	let parsed: { mcpServers?: Record<string, RawServerEntry>; servers?: Record<string, RawServerEntry> };
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		console.error(`[mcp] failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
		return {};
	}
	// Accept both the CC `mcpServers` key and Pit's own `servers` key.
	const rawServers = parsed.mcpServers ?? parsed.servers ?? {};
	const out: Record<string, McpServerConfig> = {};
	for (const [name, raw] of Object.entries(rawServers)) {
		if (raw && typeof raw === "object") out[name] = normalizeServerEntry(raw);
	}
	return out;
}

export type McpConfigScope = "user" | "project" | "local";

export interface McpConfigFiles {
	user: Record<string, McpServerConfig>;
	project: Record<string, McpServerConfig>;
	local: Record<string, McpServerConfig>;
}

/** Absolute path of the config file backing a given scope. */
export function mcpConfigFilePath(scope: McpConfigScope, cwd: string, agentDir: string): string {
	if (scope === "user") return join(agentDir, "mcp.json");
	if (scope === "project") return join(cwd, ".mcp.json");
	return join(cwd, ".mcp.local.json");
}

export function loadMcpConfigFiles(cwd: string, agentDir: string): McpConfigFiles {
	return {
		user: loadMcpConfigFile(mcpConfigFilePath("user", cwd, agentDir)),
		project: loadMcpConfigFile(mcpConfigFilePath("project", cwd, agentDir)),
		local: loadMcpConfigFile(mcpConfigFilePath("local", cwd, agentDir)),
	};
}

/**
 * Persist a server's enabled/disabled state so the /mcp panel toggle survives a
 * restart, mirroring `pit mcp enable|disable`. Edits the flag IN PLACE in the
 * highest-precedence scope file that already defines the server (local → project
 * → user) so the toggle isn't shadowed by a stronger layer. When the server is
 * only defined in settings.json (no scope file), the resolved config is written
 * as a full override into the user scope file. Best-effort: returns false on a
 * write error rather than throwing into a UI handler.
 */
export function setMcpServerDisabled(
	name: string,
	disabled: boolean,
	resolvedConfig: McpServerConfig,
	cwd: string,
	agentDir: string,
): boolean {
	const tryScope = (scope: McpConfigScope): boolean => {
		const path = mcpConfigFilePath(scope, cwd, agentDir);
		let text: string;
		try {
			text = readFileSync(path, "utf-8");
		} catch {
			return false; // file absent → server isn't defined here
		}
		let parsed: { mcpServers?: Record<string, McpServerConfig>; servers?: Record<string, McpServerConfig> };
		try {
			parsed = JSON.parse(text);
		} catch {
			return false;
		}
		const key = parsed.mcpServers ? "mcpServers" : parsed.servers ? "servers" : "mcpServers";
		const servers = parsed.mcpServers ?? parsed.servers;
		if (!servers || !servers[name]) return false;
		if (disabled) servers[name].disabled = true;
		else delete servers[name].disabled;
		writeMcpConfig(path, { ...parsed, [key]: servers });
		return true;
	};
	try {
		if (tryScope("local") || tryScope("project") || tryScope("user")) return true;
		// Settings-only server: write a full override into the user scope file.
		const userPath = mcpConfigFilePath("user", cwd, agentDir);
		const existing = loadMcpConfigFile(userPath);
		existing[name] = { ...resolvedConfig, disabled };
		if (!disabled) delete existing[name].disabled;
		writeMcpConfig(userPath, { mcpServers: existing });
		return true;
	} catch {
		return false;
	}
}

function writeMcpConfig(path: string, data: unknown): void {
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
}

/**
 * Compose the final MCP settings from the settings layers and the config files,
 * applying the documented precedence.
 */
export function composeMcpSettings(
	layered: { global: McpSettings; project: McpSettings },
	files: McpConfigFiles,
): McpSettings {
	const servers: Record<string, McpServerConfig> = {
		...(layered.global.servers ?? {}),
		...files.user,
		...files.project,
		...(layered.project.servers ?? {}),
		...files.local,
	};
	return {
		servers,
		defer: layered.project.defer ?? layered.global.defer,
		deferThreshold: layered.project.deferThreshold ?? layered.global.deferThreshold,
	};
}

/** Apply a string transform to a header/env map (skip empty results, like resolveHeaders). */
function resolveStringMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!map) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(map)) {
		// `!command` whole-value runs a shell command; otherwise `${VAR}` interpolation.
		const resolved = v.startsWith("!") ? (resolveConfigValueUncached(v) ?? "") : interpolateEnvVars(v);
		out[k] = resolved;
	}
	return out;
}

/**
 * Resolve env-var references in a server config just before the transport is
 * built. Keeps the raw config for display; returns a copy with url/command/args/
 * cwd/headers/env interpolated. Mirrors how model-registry resolves headers at
 * the point of use rather than mutating stored settings.
 */
export function resolveServerConfig(config: McpServerConfig): McpServerConfig {
	const resolved: McpServerConfig = { ...config };
	if (config.url !== undefined) resolved.url = interpolateEnvVars(config.url);
	if (config.command !== undefined) resolved.command = interpolateEnvVars(config.command);
	if (config.cwd !== undefined) resolved.cwd = interpolateEnvVars(config.cwd);
	if (config.args !== undefined) resolved.args = config.args.map((a) => interpolateEnvVars(a));
	if (config.headers !== undefined) resolved.headers = resolveStringMap(config.headers);
	if (config.env !== undefined) resolved.env = resolveStringMap(config.env);
	return resolved;
}

/**
 * Async, non-blocking mirror of resolveStringMap. `${VAR}` interpolation stays
 * sync (no spawn); only the `!command` branch awaits the non-blocking resolver
 * so a slow command yields the event loop instead of freezing it.
 */
async function resolveStringMapAsync(
	map: Record<string, string> | undefined,
): Promise<Record<string, string> | undefined> {
	if (!map) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(map)) {
		if (v.startsWith("!")) {
			out[k] = (await resolveConfigValueUncachedAsync(v)) ?? "";
		} else {
			out[k] = interpolateEnvVars(v);
		}
	}
	return out;
}

/**
 * Async, non-blocking mirror of resolveServerConfig. url/command/cwd/args use the
 * sync `${VAR}` interpolation (no spawn); headers/env use the async string-map
 * resolver so `!cmd` values don't block the event loop during MCP connect/reconnect.
 */
export async function resolveServerConfigAsync(config: McpServerConfig): Promise<McpServerConfig> {
	const resolved: McpServerConfig = { ...config };
	if (config.url !== undefined) resolved.url = interpolateEnvVars(config.url);
	if (config.command !== undefined) resolved.command = interpolateEnvVars(config.command);
	if (config.cwd !== undefined) resolved.cwd = interpolateEnvVars(config.cwd);
	if (config.args !== undefined) resolved.args = config.args.map((a) => interpolateEnvVars(a));
	if (config.headers !== undefined) resolved.headers = await resolveStringMapAsync(config.headers);
	if (config.env !== undefined) resolved.env = await resolveStringMapAsync(config.env);
	return resolved;
}
