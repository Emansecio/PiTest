/**
 * `pit mcp …` subcommands — manage MCP server configuration from the CLI,
 * mirroring `claude mcp`. Servers live in scope files (user / project / local)
 * in the Claude Code `{ "mcpServers": { … } }` format, so configs move between
 * the tools without translation.
 *
 *   pit mcp list
 *   pit mcp get <name>
 *   pit mcp add <name> <command|url> [args...] [--transport http|sse|stdio] [--scope local|project|user] [--header "K: V"] [--env K=V]
 *   pit mcp add-json <name> '<json>' [--scope ...]
 *   pit mcp remove <name> [--scope ...]
 *   pit mcp enable|disable <name> [--scope ...]
 *   pit mcp import            (merge servers from the local Claude Desktop config into user scope)
 *   pit mcp authenticate <name>   (run the OAuth browser flow for a remote server)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getAgentDir } from "./config.ts";
import { loadMcpConfigFiles, type McpConfigScope, mcpConfigFilePath } from "./core/mcp/config-files.ts";
import { authenticateMcpServer } from "./core/mcp/oauth.ts";
import type { McpServerConfig } from "./core/mcp/types.ts";
import { SettingsManager } from "./core/settings-manager.ts";

const SCOPES: McpConfigScope[] = ["user", "project", "local"];

interface ParsedFlags {
	scope: McpConfigScope;
	transport?: "http" | "sse" | "stdio";
	headers: Record<string, string>;
	env: Record<string, string>;
	positionals: string[];
	help: boolean;
}

function parseFlags(rest: string[]): ParsedFlags {
	const out: ParsedFlags = { scope: "local", headers: {}, env: {}, positionals: [], help: false };
	for (let i = 0; i < rest.length; i++) {
		const arg = rest[i];
		if (arg === "-h" || arg === "--help") out.help = true;
		else if (arg === "--scope" || arg === "-s") {
			const v = rest[++i];
			if (v && (SCOPES as string[]).includes(v)) out.scope = v as McpConfigScope;
		} else if (arg === "--transport" || arg === "-t") {
			const v = rest[++i];
			if (v === "http" || v === "sse" || v === "stdio") out.transport = v;
		} else if (arg === "--header" || arg === "-H") {
			const v = rest[++i] ?? "";
			const idx = v.indexOf(":");
			if (idx > 0) out.headers[v.slice(0, idx).trim()] = v.slice(idx + 1).trim();
		} else if (arg === "--env" || arg === "-e") {
			const v = rest[++i] ?? "";
			const idx = v.indexOf("=");
			if (idx > 0) out.env[v.slice(0, idx).trim()] = v.slice(idx + 1);
		} else {
			out.positionals.push(arg);
		}
	}
	return out;
}

function readScopeFile(path: string): Record<string, McpServerConfig> {
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
			mcpServers?: Record<string, McpServerConfig>;
			servers?: Record<string, McpServerConfig>;
		};
		return parsed.mcpServers ?? parsed.servers ?? {};
	} catch {
		return {};
	}
}

function writeScopeFile(path: string, servers: Record<string, McpServerConfig>): void {
	writeFileSync(path, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`, "utf-8");
}

function targetOf(cfg: McpServerConfig): string {
	if (cfg.url) return cfg.url;
	if (cfg.command) return [cfg.command, ...(cfg.args ?? [])].join(" ");
	return "(unconfigured)";
}

function usage(): void {
	console.log(`Usage:
  pit mcp list
  pit mcp get <name>
  pit mcp add <name> <command|url> [args...] [--transport http|sse|stdio] [--scope local|project|user] [--header "K: V"] [--env K=V]
  pit mcp add-json <name> '<json>' [--scope ...]
  pit mcp remove <name> [--scope ...]
  pit mcp enable|disable <name> [--scope ...]
  pit mcp import
  pit mcp authenticate <name>`);
}

export async function handleMcpCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "mcp") return false;
	const sub = args[1];
	const rest = args.slice(2);
	const cwd = process.cwd();
	const agentDir = getAgentDir();

	if (!sub || sub === "-h" || sub === "--help") {
		usage();
		return true;
	}

	switch (sub) {
		case "list":
			cmdList(cwd, agentDir);
			return true;
		case "get":
			cmdGet(rest, cwd, agentDir);
			return true;
		case "add":
			cmdAdd(rest, cwd, agentDir);
			return true;
		case "add-json":
			cmdAddJson(rest, cwd, agentDir);
			return true;
		case "remove":
		case "rm":
			cmdRemove(rest, cwd, agentDir);
			return true;
		case "enable":
			cmdToggle(rest, cwd, agentDir, false);
			return true;
		case "disable":
			cmdToggle(rest, cwd, agentDir, true);
			return true;
		case "import":
		case "add-from-claude-desktop":
			cmdImport(cwd, agentDir);
			return true;
		case "authenticate":
		case "auth":
			await cmdAuthenticate(rest, cwd, agentDir);
			return true;
		default:
			console.error(chalk.red(`Unknown mcp subcommand "${sub}".`));
			usage();
			process.exitCode = 1;
			return true;
	}
}

function cmdList(cwd: string, agentDir: string): void {
	const files = loadMcpConfigFiles(cwd, agentDir);
	const settingsManager = SettingsManager.create(cwd, agentDir);
	const layered = settingsManager.getMcpSettingsLayered();
	const sources: Array<[string, Record<string, McpServerConfig>]> = [
		["global settings", layered.global.servers ?? {}],
		["user file", files.user],
		["project .mcp.json", files.project],
		["project settings", layered.project.servers ?? {}],
		["local file", files.local],
	];
	let any = false;
	for (const [label, servers] of sources) {
		const names = Object.keys(servers);
		if (names.length === 0) continue;
		any = true;
		console.log(chalk.bold(`${label}:`));
		for (const name of names) {
			const cfg = servers[name];
			const dis = cfg.disabled ? chalk.dim(" (disabled)") : "";
			console.log(`  ${name}  ${chalk.dim(targetOf(cfg))}${dis}`);
		}
	}
	if (!any) console.log(chalk.dim("No MCP servers configured."));
}

function cmdGet(rest: string[], cwd: string, agentDir: string): void {
	const name = rest[0];
	if (!name) {
		console.error(chalk.red("Usage: pit mcp get <name>"));
		process.exitCode = 1;
		return;
	}
	for (const scope of SCOPES) {
		const servers = readScopeFile(mcpConfigFilePath(scope, cwd, agentDir));
		if (servers[name]) {
			console.log(chalk.bold(`${name} (${scope}):`));
			console.log(JSON.stringify(servers[name], null, 2));
			return;
		}
	}
	console.error(chalk.red(`No MCP server "${name}" found in user/project/local files.`));
	process.exitCode = 1;
}

function cmdAdd(rest: string[], cwd: string, agentDir: string): void {
	const flags = parseFlags(rest);
	if (flags.help) {
		usage();
		return;
	}
	const [name, target, ...extra] = flags.positionals;
	if (!name || !target) {
		console.error(chalk.red("Usage: pit mcp add <name> <command|url> [args...]"));
		process.exitCode = 1;
		return;
	}
	const isUrl = /^https?:\/\//i.test(target);
	const cfg: McpServerConfig = {};
	if (isUrl) {
		cfg.transport = flags.transport ?? "http";
		cfg.url = target;
		if (Object.keys(flags.headers).length > 0) cfg.headers = flags.headers;
	} else {
		cfg.transport = flags.transport ?? "stdio";
		cfg.command = target;
		if (extra.length > 0) cfg.args = extra;
		if (Object.keys(flags.env).length > 0) cfg.env = flags.env;
	}
	writeServer(name, cfg, flags.scope, cwd, agentDir);
	console.log(chalk.green(`Added MCP server "${name}" (${flags.scope}): ${targetOf(cfg)}`));
}

function cmdAddJson(rest: string[], cwd: string, agentDir: string): void {
	const flags = parseFlags(rest);
	const [name, json] = flags.positionals;
	if (!name || !json) {
		console.error(chalk.red(`Usage: pit mcp add-json <name> '<json>'`));
		process.exitCode = 1;
		return;
	}
	let cfg: McpServerConfig;
	try {
		cfg = JSON.parse(json) as McpServerConfig;
		// Accept the CC `type` alias for transport.
		const withType = cfg as McpServerConfig & { type?: "http" | "sse" | "stdio" };
		if (withType.type && !cfg.transport) cfg.transport = withType.type;
	} catch (err) {
		console.error(chalk.red(`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
		process.exitCode = 1;
		return;
	}
	writeServer(name, cfg, flags.scope, cwd, agentDir);
	console.log(chalk.green(`Added MCP server "${name}" (${flags.scope}).`));
}

function cmdRemove(rest: string[], cwd: string, agentDir: string): void {
	const flags = parseFlags(rest);
	const name = flags.positionals[0];
	if (!name) {
		console.error(chalk.red("Usage: pit mcp remove <name> [--scope ...]"));
		process.exitCode = 1;
		return;
	}
	// Remove from the named scope if it has the server; otherwise from wherever it lives.
	const scopesToTry = flags.positionals.includes(name) && rest.includes("--scope") ? [flags.scope] : SCOPES;
	let removed = false;
	for (const scope of scopesToTry) {
		const path = mcpConfigFilePath(scope, cwd, agentDir);
		const servers = readScopeFile(path);
		if (servers[name]) {
			delete servers[name];
			writeScopeFile(path, servers);
			console.log(chalk.green(`Removed MCP server "${name}" (${scope}).`));
			removed = true;
		}
	}
	if (!removed) {
		console.error(chalk.red(`No MCP server "${name}" found in user/project/local files.`));
		process.exitCode = 1;
	}
}

function cmdToggle(rest: string[], cwd: string, agentDir: string, disabled: boolean): void {
	const flags = parseFlags(rest);
	const name = flags.positionals[0];
	if (!name) {
		console.error(chalk.red(`Usage: pit mcp ${disabled ? "disable" : "enable"} <name>`));
		process.exitCode = 1;
		return;
	}
	for (const scope of SCOPES) {
		const path = mcpConfigFilePath(scope, cwd, agentDir);
		const servers = readScopeFile(path);
		if (servers[name]) {
			if (disabled) servers[name].disabled = true;
			else delete servers[name].disabled;
			writeScopeFile(path, servers);
			console.log(chalk.green(`${disabled ? "Disabled" : "Enabled"} MCP server "${name}" (${scope}).`));
			return;
		}
	}
	console.error(chalk.red(`No MCP server "${name}" found in user/project/local files.`));
	process.exitCode = 1;
}

function claudeDesktopConfigPath(): string {
	if (process.platform === "win32")
		return join(process.env.APPDATA ?? join(homedir(), "AppData/Roaming"), "Claude", "claude_desktop_config.json");
	if (process.platform === "darwin")
		return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
	return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "Claude", "claude_desktop_config.json");
}

function cmdImport(cwd: string, agentDir: string): void {
	const path = claudeDesktopConfigPath();
	if (!existsSync(path)) {
		console.error(chalk.red(`Claude Desktop config not found at ${path}`));
		process.exitCode = 1;
		return;
	}
	let parsed: { mcpServers?: Record<string, McpServerConfig & { type?: "http" | "sse" | "stdio" }> };
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch (err) {
		console.error(chalk.red(`Failed to parse ${path}: ${err instanceof Error ? err.message : String(err)}`));
		process.exitCode = 1;
		return;
	}
	const incoming = parsed.mcpServers ?? {};
	const names = Object.keys(incoming);
	if (names.length === 0) {
		console.log(chalk.dim("No MCP servers found in the Claude Desktop config."));
		return;
	}
	const userPath = mcpConfigFilePath("user", cwd, agentDir);
	const existing = readScopeFile(userPath);
	for (const name of names) {
		const raw = incoming[name];
		if (raw.type && !raw.transport) raw.transport = raw.type;
		delete (raw as { type?: unknown }).type;
		existing[name] = raw;
	}
	writeScopeFile(userPath, existing);
	console.log(chalk.green(`Imported ${names.length} MCP server(s) into user scope: ${names.join(", ")}`));
}

async function cmdAuthenticate(rest: string[], cwd: string, agentDir: string): Promise<void> {
	const name = rest[0];
	if (!name) {
		console.error(chalk.red("Usage: pit mcp authenticate <name>"));
		process.exitCode = 1;
		return;
	}
	// Resolve the server config across all scopes.
	let cfg: McpServerConfig | undefined;
	for (const scope of SCOPES) {
		const servers = readScopeFile(mcpConfigFilePath(scope, cwd, agentDir));
		if (servers[name]) {
			cfg = servers[name];
			break;
		}
	}
	if (!cfg) {
		const layered = SettingsManager.create(cwd, agentDir).getMcpSettingsLayered();
		cfg = layered.project.servers?.[name] ?? layered.global.servers?.[name];
	}
	if (!cfg || !cfg.url) {
		console.error(chalk.red(`No remote (http/sse) MCP server "${name}" found to authenticate.`));
		process.exitCode = 1;
		return;
	}
	try {
		await authenticateMcpServer(name, cfg, agentDir);
		console.log(chalk.green(`Authenticated MCP server "${name}". Token stored.`));
	} catch (err) {
		console.error(chalk.red(`Authentication failed: ${err instanceof Error ? err.message : String(err)}`));
		process.exitCode = 1;
	}
}

function writeServer(name: string, cfg: McpServerConfig, scope: McpConfigScope, cwd: string, agentDir: string): void {
	const path = mcpConfigFilePath(scope, cwd, agentDir);
	const servers = readScopeFile(path);
	servers[name] = cfg;
	writeScopeFile(path, servers);
}
