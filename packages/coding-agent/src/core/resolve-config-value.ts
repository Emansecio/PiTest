/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { promisify } from "node:util";
import { exec, execFile, execSync, spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.ts";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// Short-lived TTL memo for `!command` resolvers. The per-request
// auth path (model-registry.getApiKeyAndHeaders → apiKey + provider headers +
// model headers, plus retries and overlapping turns) resolves the same handful
// of commands repeatedly; without this each one spawned a fresh shell before
// every model request, adding 50–200ms (Windows especially) to time-to-first-
// token. Bounded to configCommandTtlMs() so rotating tokens stay fresh, and
// failures are never memoised (a flaky command
// must not turn into a sticky auth outage).
const ttlCommandCache = new Map<string, { value: string; expiresAt: number }>();
const DEFAULT_CONFIG_COMMAND_TTL_MS = 30_000;

// Window for ttlCommandCache, overridable via PIT_CONFIG_COMMAND_TTL_MS
// (milliseconds; 0 disables the memo and restores fresh-every-call behaviour).
function configCommandTtlMs(): number {
	const raw = process.env.PIT_CONFIG_COMMAND_TTL_MS;
	if (raw === undefined) return DEFAULT_CONFIG_COMMAND_TTL_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_CONFIG_COMMAND_TTL_MS;
}

function ttlCacheGet(commandConfig: string): string | undefined {
	const entry = ttlCommandCache.get(commandConfig);
	if (entry && entry.expiresAt > Date.now()) return entry.value;
	return undefined;
}

function ttlCacheSet(commandConfig: string, value: string | undefined): void {
	if (value === undefined) return; // never memoise failures/empty output
	const ttl = configCommandTtlMs();
	if (ttl <= 0) return;
	ttlCommandCache.set(commandConfig, { value, expiresAt: Date.now() + ttl });
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Otherwise checks environment variable first, then treats as literal (not cached)
 */
export function resolveConfigValue(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommand(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args } = getShellConfig();
		const result = spawnSync(shell, [...args, command], {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
			shell: false,
			windowsHide: true,
		});

		if (result.error) {
			const error = result.error as NodeJS.ErrnoException;
			if (error.code === "ENOENT") {
				return { executed: false, value: undefined };
			}
			return { executed: true, value: undefined };
		}

		if (result.status !== 0) {
			return { executed: true, value: undefined };
		}

		const value = (result.stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	try {
		const output = execSync(command, {
			encoding: "utf-8",
			timeout: 10000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return output.trim() || undefined;
	} catch {
		return undefined;
	}
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const cached = ttlCacheGet(commandConfig);
	if (cached !== undefined) {
		return cached;
	}
	const command = commandConfig.slice(1);
	let value: string | undefined;
	if (process.platform === "win32") {
		const configuredResult = executeWithConfiguredShell(command);
		value = configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
	} else {
		value = executeWithDefaultShell(command);
	}
	ttlCacheSet(commandConfig, value);
	return value;
}

function executeCommand(commandConfig: string): string | undefined {
	return executeCommandUncached(commandConfig);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string): string | undefined {
	if (config.startsWith("!")) {
		return executeCommandUncached(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

/**
 * Async, non-blocking mirror of executeWithConfiguredShell. Used by the MCP
 * transport-resolution path so a slow `!cmd` (up to the 10s timeout) yields the
 * event loop instead of freezing it. Same params as the sync version 1:1
 * (configured shell, timeout 10000, stdio ignore/pipe/ignore, shell:false,
 * windowsHide, trim, undefined on failure/status!=0/empty).
 */
async function executeWithConfiguredShellAsync(
	command: string,
): Promise<{ executed: boolean; value: string | undefined }> {
	try {
		const { shell, args } = getShellConfig();
		const { stdout } = await execFileAsync(shell, [...args, command], {
			encoding: "utf-8",
			timeout: 10000,
			windowsHide: true,
			shell: false,
		});
		const value = (stdout ?? "").trim();
		return { executed: true, value: value || undefined };
	} catch (err) {
		const error = err as NodeJS.ErrnoException;
		// ENOENT = shell binary not found -> not executed (caller falls back to default shell).
		if (error?.code === "ENOENT") {
			return { executed: false, value: undefined };
		}
		// Any other failure (non-zero exit, timeout) = executed but no usable value.
		return { executed: true, value: undefined };
	}
}

/** Async, non-blocking mirror of executeWithDefaultShell (execSync -> promisified exec). */
async function executeWithDefaultShellAsync(command: string): Promise<string | undefined> {
	try {
		const { stdout } = await execAsync(command, {
			encoding: "utf-8",
			timeout: 10000,
		});
		return stdout.trim() || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Async, non-blocking mirror of executeCommandUncached. Consults the short-lived TTL memo
 * (ttlCommandCache) so the per-request auth path does not re-spawn the same
 * `!command` on every turn. Only successful (defined) results are memoised, and
 * only for configCommandTtlMs(); transient failures are never cached and
 * rotating tokens stay fresh within the small window (0 disables it entirely).
 * Written with if/else, not a nested ternary IIFE, to satisfy tsgo
 * erasableSyntaxOnly lint.
 */
async function executeCommandUncachedAsync(commandConfig: string): Promise<string | undefined> {
	const cached = ttlCacheGet(commandConfig);
	if (cached !== undefined) {
		return cached;
	}
	const command = commandConfig.slice(1);
	let value: string | undefined;
	if (process.platform === "win32") {
		const configuredResult = await executeWithConfiguredShellAsync(command);
		value = configuredResult.executed ? configuredResult.value : await executeWithDefaultShellAsync(command);
	} else {
		value = await executeWithDefaultShellAsync(command);
	}
	ttlCacheSet(commandConfig, value);
	return value;
}

/**
 * Async, non-blocking mirror of resolveConfigValueUncached. `!cmd` runs the
 * command without blocking the event loop; `${VAR}`/env/literal resolution is
 * identical to the sync version.
 */
export async function resolveConfigValueUncachedAsync(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) {
		return executeCommandUncachedAsync(config);
	}
	const envValue = process.env[config];
	return envValue || config;
}

export function resolveConfigValueOrThrow(config: string, description: string): string {
	const resolvedValue = resolveConfigValueUncached(config);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	if (config.startsWith("!")) {
		throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
	}

	throw new Error(`Failed to resolve ${description}`);
}

export async function resolveConfigValueOrThrowAsync(config: string, description: string): Promise<string> {
	const resolvedValue = await resolveConfigValueUncachedAsync(config);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	if (config.startsWith("!")) {
		throw new Error(`Failed to resolve ${description} from shell command: ${config.slice(1)}`);
	}

	throw new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export async function resolveHeadersOrThrowAsync(
	headers: Record<string, string> | undefined,
	description: string,
): Promise<Record<string, string> | undefined> {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = await resolveConfigValueOrThrowAsync(value, `${description} header "${key}"`);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	ttlCommandCache.clear();
}

/**
 * Expand shell-style `${VAR}` / `${VAR:-default}` references inside a string.
 *
 * Matches the `.mcp.json` convention used across the MCP ecosystem (Claude Code
 * et al.) so configs authored for those tools import cleanly. `${VAR}` expands to
 * the env value or "" if unset; `${VAR:-default}` falls back to `default` when
 * the variable is unset OR empty. Other text passes through verbatim. This is
 * substring interpolation, distinct from `resolveConfigValue` (whole-value env
 * name or `!command`).
 */
export function interpolateEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback?: string) => {
		const resolved = env[name];
		if (resolved !== undefined && resolved !== "") return resolved;
		return fallback ?? "";
	});
}
