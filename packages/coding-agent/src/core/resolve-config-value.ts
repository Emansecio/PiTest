/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { execSync, spawn, spawnSync } from "child_process";
import { getShellConfig, killProcessTreeAndWait } from "../utils/shell.ts";

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
// Keep parity with child_process.exec/execFile's default maxBuffer.
const MAX_CONFIG_COMMAND_STDOUT_BYTES = 1024 * 1024;

function throwIfAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	throw signal.reason === undefined ? new Error("aborted") : signal.reason;
}

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
 * Run a shell command asynchronously. Abort, timeout, and excessive output make a
 * bounded attempt to reap the process tree before settling; a failed cleanup does
 * not replace an AbortSignal's reason.
 */
async function executeShellCommandAsync(
	file: string,
	args: string[],
	shell: boolean,
	signal?: AbortSignal,
): Promise<{ code: number | null; error?: NodeJS.ErrnoException; stdout: string }> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		let settled = false;
		let stopping = false;
		const stdoutChunks: Buffer[] = [];
		let stdoutBytes = 0;
		const child = spawn(file, args, {
			detached: process.platform !== "win32",
			shell,
			stdio: ["ignore", "pipe", "ignore"],
			windowsHide: true,
		});
		const stdout = (): string => Buffer.concat(stdoutChunks).toString("utf-8");

		const finish = (result: { code: number | null; error?: NodeJS.ErrnoException; stdout: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		const failAbort = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			try {
				throwIfAborted(signal);
			} catch (error) {
				reject(error);
			}
		};
		const stop = async (aborted: boolean): Promise<void> => {
			if (stopping || settled) return;
			stopping = true;
			clearTimeout(timeout);
			if (aborted) failAbort();
			if (child.pid !== undefined) {
				await killProcessTreeAndWait(child.pid).catch(() => false);
			}
			if (!aborted) finish({ code: null, stdout: stdout() });
		};
		const onAbort = (): void => {
			void stop(true);
		};
		const timeout = setTimeout(() => {
			void stop(false);
		}, 10000);

		child.stdout?.on("data", (chunk: Buffer | string) => {
			const buffer = Buffer.from(chunk);
			stdoutBytes += buffer.length;
			if (stdoutBytes > MAX_CONFIG_COMMAND_STDOUT_BYTES) {
				void stop(false);
				return;
			}
			stdoutChunks.push(buffer);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			if (!stopping) finish({ code: null, error, stdout: stdout() });
		});
		child.on("close", (code) => {
			if (!stopping) finish({ code, stdout: stdout() });
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

async function executeWithConfiguredShellAsync(
	command: string,
	signal?: AbortSignal,
): Promise<{ executed: boolean; value: string | undefined }> {
	let shellConfig: ReturnType<typeof getShellConfig>;
	try {
		shellConfig = getShellConfig();
	} catch {
		throwIfAborted(signal);
		return { executed: false, value: undefined };
	}
	try {
		const result = await executeShellCommandAsync(shellConfig.shell, [...shellConfig.args, command], false, signal);
		if (result.error?.code === "ENOENT") return { executed: false, value: undefined };
		if (result.error || result.code !== 0) return { executed: true, value: undefined };
		const value = result.stdout.trim();
		return { executed: true, value: value || undefined };
	} catch {
		throwIfAborted(signal);
		return { executed: true, value: undefined };
	}
}

/** Async, non-blocking mirror of executeWithDefaultShell (execSync -> promisified exec). */
async function executeWithDefaultShellAsync(command: string, signal?: AbortSignal): Promise<string | undefined> {
	try {
		const result = await executeShellCommandAsync(command, [], true, signal);
		if (result.error || result.code !== 0) return undefined;
		return result.stdout.trim() || undefined;
	} catch {
		throwIfAborted(signal);
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
async function executeCommandUncachedAsync(commandConfig: string, signal?: AbortSignal): Promise<string | undefined> {
	throwIfAborted(signal);
	const cached = ttlCacheGet(commandConfig);
	if (cached !== undefined) {
		return cached;
	}
	const command = commandConfig.slice(1);
	let value: string | undefined;
	if (process.platform === "win32") {
		const configuredResult = await executeWithConfiguredShellAsync(command, signal);
		value = configuredResult.executed ? configuredResult.value : await executeWithDefaultShellAsync(command, signal);
	} else {
		value = await executeWithDefaultShellAsync(command, signal);
	}
	throwIfAborted(signal);
	ttlCacheSet(commandConfig, value);
	return value;
}

/**
 * Async, non-blocking mirror of resolveConfigValueUncached. `!cmd` runs the
 * command without blocking the event loop; `${VAR}`/env/literal resolution is
 * identical to the sync version.
 */
export async function resolveConfigValueUncachedAsync(
	config: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	throwIfAborted(signal);
	if (config.startsWith("!")) {
		return executeCommandUncachedAsync(config, signal);
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

export async function resolveConfigValueOrThrowAsync(
	config: string,
	description: string,
	signal?: AbortSignal,
): Promise<string> {
	const resolvedValue = await resolveConfigValueUncachedAsync(config, signal);
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
