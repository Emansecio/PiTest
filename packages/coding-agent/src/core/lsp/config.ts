/**
 * LSP configuration: merge built-in defaults with project/user override files
 * (JSON or YAML), then auto-detect servers by intersecting project root markers
 * with available binaries (project-local bins first, then $PATH).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { minimatch } from "minimatch";
import { parse as parseYaml } from "yaml";
import DEFAULTS from "./defaults.ts";
import { isRecord, log, which } from "./internal.ts";
import type { ServerConfig } from "./types.ts";

export interface LspConfig {
	servers: Record<string, ServerConfig>;
	/** Idle timeout in ms; LSP clients shut down after this period of inactivity. Disabled by default. */
	idleTimeoutMs?: number;
}

const PID_TOKEN = "$PID";

interface RawServerConfig extends Partial<ServerConfig> {
	extensionToLanguage?: unknown;
	initializationOptions?: unknown;
}

interface NormalizedConfig {
	servers: Record<string, RawServerConfig>;
	idleTimeoutMs?: number;
}

function parseConfigContent(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return parseYaml(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}

function normalizeConfig(value: unknown): NormalizedConfig | null {
	if (!isRecord(value)) return null;
	const idleTimeoutMs = typeof value.idleTimeoutMs === "number" ? value.idleTimeoutMs : undefined;
	const rawServers = value.servers;
	if (isRecord(rawServers)) {
		return { servers: rawServers as Record<string, RawServerConfig>, idleTimeoutMs };
	}
	const servers = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "idleTimeoutMs")) as Record<
		string,
		RawServerConfig
	>;
	return { servers, idleTimeoutMs };
}

function normalizeStringArray(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
	return items.length > 0 ? items : null;
}

function normalizeExtensionToFileTypes(value: unknown): string[] | null {
	if (!isRecord(value)) return null;
	const extensions = Object.keys(value).filter((extension) => extension.length > 0);
	return extensions.length > 0 ? extensions : null;
}

function normalizeServerConfig(name: string, config: RawServerConfig): ServerConfig | null {
	const command = typeof config.command === "string" && config.command.length > 0 ? config.command : null;
	const fileTypes =
		normalizeStringArray(config.fileTypes) ?? normalizeExtensionToFileTypes(config.extensionToLanguage);
	const rootMarkers = normalizeStringArray(config.rootMarkers) ?? (config.extensionToLanguage ? ["."] : null);

	if (!command || !fileTypes || !rootMarkers) {
		log.warn("Ignoring invalid LSP server config (missing required fields).", { name });
		return null;
	}

	const args = Array.isArray(config.args)
		? config.args.filter((entry): entry is string => typeof entry === "string")
		: undefined;
	const initOptions = isRecord(config.initOptions)
		? config.initOptions
		: isRecord(config.initializationOptions)
			? config.initializationOptions
			: undefined;

	return {
		...config,
		command,
		args,
		fileTypes,
		rootMarkers,
		...(initOptions ? { initOptions } : {}),
	};
}

function readConfigFile(filePath: string): NormalizedConfig | null {
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = parseConfigContent(content, filePath);
		return normalizeConfig(parsed);
	} catch {
		return null;
	}
}

function coerceServerConfigs(servers: Record<string, RawServerConfig>): Record<string, ServerConfig> {
	const result: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(servers)) {
		const normalized = normalizeServerConfig(name, config);
		if (normalized) result[name] = normalized;
	}
	return result;
}

function mergeServers(
	base: Record<string, ServerConfig>,
	overrides: Record<string, RawServerConfig>,
): Record<string, ServerConfig> {
	const merged: Record<string, ServerConfig> = { ...base };
	for (const [name, config] of Object.entries(overrides)) {
		if (merged[name]) {
			const candidate = { ...merged[name], ...config };
			const normalized = normalizeServerConfig(name, candidate);
			if (normalized) merged[name] = normalized;
			else log.warn("Ignoring invalid LSP overrides (keeping previous config).", { name });
		} else {
			const normalized = normalizeServerConfig(name, config);
			if (normalized) merged[name] = normalized;
		}
	}
	return merged;
}

function applyRuntimeDefaults(servers: Record<string, ServerConfig>): Record<string, ServerConfig> {
	const updated: Record<string, ServerConfig> = { ...servers };
	if (updated.omnisharp?.args) {
		const args = updated.omnisharp.args.map((arg) => (arg === PID_TOKEN ? String(process.pid) : arg));
		updated.omnisharp = { ...updated.omnisharp, args };
	}
	return updated;
}

// =============================================================================
// Root Markers + Binary Resolution
// =============================================================================

/** Check if any root marker file exists in the directory (glob markers supported). */
export function hasRootMarkers(cwd: string, markers: string[]): boolean {
	let entries: string[] | null = null;
	for (const marker of markers) {
		if (marker.includes("*")) {
			if (entries === null) {
				try {
					entries = fs.readdirSync(cwd);
				} catch {
					entries = [];
					log.warn("Failed to list directory for glob root marker.", { marker, cwd });
				}
			}
			for (const entry of entries) {
				if (minimatch(entry, marker)) return true;
			}
			continue;
		}
		if (fs.existsSync(path.join(cwd, marker))) return true;
	}
	return false;
}

const PYTHON_MARKERS = ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"];

/** Project-local bin dirs to probe (Unix + Windows Python Scripts). */
const LOCAL_BIN_PATHS: Array<{ markers: string[]; binDir: string }> = [
	{ markers: ["package.json", "package-lock.json", "yarn.lock", "pnpm-lock.yaml"], binDir: "node_modules/.bin" },
	{ markers: PYTHON_MARKERS, binDir: ".venv/bin" },
	{ markers: PYTHON_MARKERS, binDir: "venv/bin" },
	{ markers: PYTHON_MARKERS, binDir: ".env/bin" },
	// Windows venvs put executables under Scripts/, not bin/.
	{ markers: PYTHON_MARKERS, binDir: ".venv/Scripts" },
	{ markers: PYTHON_MARKERS, binDir: "venv/Scripts" },
	{ markers: PYTHON_MARKERS, binDir: ".env/Scripts" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "vendor/bundle/bin" },
	{ markers: ["Gemfile", "Gemfile.lock"], binDir: "bin" },
	{ markers: ["go.mod", "go.sum"], binDir: "bin" },
];

const WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS = [".exe", ".cmd", ".bat"] as const;

function resolveLocalCommand(basePath: string): string | null {
	if (process.platform === "win32") {
		// Prefer a Windows executable (.exe/.cmd/.bat) over the extensionless Unix
		// shell wrapper npm drops alongside the `.cmd` in node_modules/.bin. The
		// wrapper matches existsSync but can't be spawned, so it must not win.
		for (const extension of WINDOWS_LOCAL_EXECUTABLE_EXTENSIONS) {
			const candidate = `${basePath}${extension}`;
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	if (fs.existsSync(basePath)) return basePath;
	return null;
}

/**
 * Absolute path to `@pit/coding-agent`'s package root (src/ or dist/ → ../..).
 * Used so optionalDeps like typescript-language-server resolve even when the
 * user's project cwd does not install them.
 */
export function getCodingAgentPackageRoot(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	// src/core/lsp or dist/core/lsp → package root
	return path.resolve(here, "../../..");
}

/** Resolve a command under a specific package's node_modules/.bin. */
export function resolvePackageBinCommand(command: string, packageRoot: string): string | null {
	return resolveLocalCommand(path.join(packageRoot, "node_modules", ".bin", command));
}

/** Resolve a command to an executable path: project-local bins, Pit package bins, then $PATH. */
export function resolveCommand(
	command: string,
	cwd: string,
	packageRoots: string[] = [getCodingAgentPackageRoot(), path.resolve(getCodingAgentPackageRoot(), "../..")],
): string | null {
	for (const { markers, binDir } of LOCAL_BIN_PATHS) {
		if (hasRootMarkers(cwd, markers)) {
			const localPath = path.join(cwd, binDir, command);
			const resolvedLocalPath = resolveLocalCommand(localPath);
			if (resolvedLocalPath) return resolvedLocalPath;
		}
	}
	for (const root of packageRoots) {
		const fromPackage = resolvePackageBinCommand(command, root);
		if (fromPackage) return fromPackage;
	}
	return which(command);
}

const TS_PROJECT_MARKERS = ["package.json", "tsconfig.json", "jsconfig.json"];
const TS_FILE_TYPES = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** True when cwd looks like a JS/TS project (package.json or ts/jsconfig). */
export function hasTypescriptProjectMarkers(cwd: string): boolean {
	return hasRootMarkers(cwd, TS_PROJECT_MARKERS);
}

/**
 * True when the project has TS markers but no non-linter LSP server that
 * handles TypeScript/JavaScript files was auto-detected (e.g. only biome).
 */
export function missingTypescriptLsp(config: LspConfig, cwd: string): boolean {
	if (!hasTypescriptProjectMarkers(cwd)) return false;
	for (const server of Object.values(config.servers)) {
		if (server.isLinter) continue;
		if (server.fileTypes.some((ft) => TS_FILE_TYPES.has(ft.toLowerCase()))) return false;
	}
	return true;
}

/** One-line startup warning when a TS project has no TypeScript language server. */
export function typescriptLspMissingWarning(cwd: string, config?: LspConfig): string | undefined {
	const cfg = config ?? loadConfig(cwd);
	if (!missingTypescriptLsp(cfg, cwd)) return undefined;
	return (
		"No TypeScript language server detected (only linters like biome/eslint, or none). " +
		"Install typescript-language-server (bundled as an optional dependency of Pit) or add it to PATH / lsp.json."
	);
}

// =============================================================================
// Config Sources
// =============================================================================

const CONFIG_FILENAMES = ["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];

export function getConfigSources(cwd: string): string[] {
	const sources: string[] = [];
	// 1. Project root (highest priority)
	for (const filename of CONFIG_FILENAMES) sources.push(path.join(cwd, filename));
	// 2. Project config dirs
	for (const dir of [".pit", ".claude"]) {
		for (const filename of CONFIG_FILENAMES) sources.push(path.join(cwd, dir, filename));
	}
	// 3. User config dirs
	const home = os.homedir();
	for (const dir of [path.join(home, ".pit", "agent"), path.join(home, ".pit"), path.join(home, ".claude")]) {
		for (const filename of CONFIG_FILENAMES) sources.push(path.join(dir, filename));
	}
	// 4. User home root (lowest priority)
	for (const filename of CONFIG_FILENAMES) sources.push(path.join(home, filename));
	return sources;
}

/**
 * Snapshot mtimes for every LSP config source path.
 * Missing files are recorded as `null` so create/delete also invalidates the cache.
 */
export function readLspConfigSourceMtimes(cwd: string): Map<string, number | null> {
	const mtimes = new Map<string, number | null>();
	for (const source of getConfigSources(cwd)) {
		try {
			mtimes.set(source, fs.statSync(source).mtimeMs);
		} catch {
			mtimes.set(source, null);
		}
	}
	return mtimes;
}

/**
 * Load LSP configuration. Override files are merged lowest-to-highest priority;
 * when no server overrides exist, servers are auto-detected from project markers
 * and available binaries.
 */
export function loadConfig(cwd: string): LspConfig {
	let mergedServers = coerceServerConfigs(DEFAULTS as unknown as Record<string, RawServerConfig>);

	// Sources are returned highest-first; reverse so higher priority is applied last.
	const configSources = getConfigSources(cwd).reverse();
	let idleTimeoutMs: number | undefined;

	for (const source of configSources) {
		const parsed = readConfigFile(source);
		if (!parsed) continue;
		if (Object.keys(parsed.servers).length > 0) {
			mergedServers = mergeServers(mergedServers, parsed.servers);
		}
		if (parsed.idleTimeoutMs !== undefined) idleTimeoutMs = parsed.idleTimeoutMs;
	}

	// Detect available servers by intersecting project markers with resolvable
	// binaries. The selection is identical whether the set came from built-in
	// defaults or merged overrides, so there is no separate code path for either.
	const servers: Record<string, ServerConfig> = {};
	for (const [name, config] of Object.entries(applyRuntimeDefaults(mergedServers))) {
		if (config.disabled) continue;
		if (!hasRootMarkers(cwd, config.rootMarkers)) continue;
		const resolved = resolveCommand(config.command, cwd);
		if (!resolved) continue;
		servers[name] = { ...config, resolvedCommand: resolved };
	}
	return { servers, idleTimeoutMs };
}

// =============================================================================
// Server Selection
// =============================================================================

/** Find all servers that can handle a file (primary/non-linter first). */
export function getServersForFile(config: LspConfig, filePath: string): Array<[string, ServerConfig]> {
	const ext = path.extname(filePath).toLowerCase();
	const fileName = path.basename(filePath).toLowerCase();
	const matches: Array<[string, ServerConfig]> = [];
	for (const [name, serverConfig] of Object.entries(config.servers)) {
		const supportsFile = serverConfig.fileTypes.some((fileType) => {
			const normalized = fileType.toLowerCase();
			return normalized === ext || normalized === fileName;
		});
		if (supportsFile) matches.push([name, serverConfig]);
	}
	return matches.sort((a, b) => {
		const aIsLinter = a[1].isLinter ? 1 : 0;
		const bIsLinter = b[1].isLinter ? 1 : 0;
		return aIsLinter - bIsLinter;
	});
}

/** Find the primary server for a file (prefers type-checkers over linters). */
export function getServerForFile(config: LspConfig, filePath: string): [string, ServerConfig] | null {
	const servers = getServersForFile(config, filePath);
	return servers.length > 0 ? servers[0] : null;
}
