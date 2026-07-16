import { exec } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { getAgentDir } from "../config.ts";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";

// Anthropic routes Pro/Max OAuth traffic by the Claude Code fingerprint, and the
// spoofed user-agent VERSION is part of it. A version too far behind the actual
// release gets intermittent 5xx (overloaded_error) on OAuth traffic — worst on
// the newest models. The provider (@pit/ai) carries a static fallback; this
// Node-only helper detects the installed CLI so the spoofed version tracks the
// real release instead of going stale. (@pit/ai can't run a subprocess — it is
// covered by the browser smoke build.)
//
// Detection is asynchronous (spawn, not execSync) so the ~0.4s warm / up to
// ~2.7s cold `claude --version` overlaps with the runtime's module eval instead
// of blocking boot. The detected version is cached on disk in the agent dir,
// keyed by the resolved `claude` binary's path+mtime+size — a cache hit skips
// the spawn entirely, and updating/reinstalling the CLI invalidates the entry
// automatically. Escape hatch: PIT_NO_CLAUDE_VERSION_CACHE=1 disables the disk
// cache (detection still runs, uncached). PIT_CLAUDE_CODE_VERSION remains the
// manual pin and short-circuits everything.

const VERSION_COMMANDS = ["claude", "claude-code"] as const;
const VERSION_CACHE_FILE = "claude-code-version.json";
const VERSION_CACHE_SCHEMA = 1;
const SPAWN_TIMEOUT_MS = 3000;

/** The `claude` binary as resolved from PATH, with its cache-key identity. */
export interface ResolvedClaudeBinary {
	path: string;
	mtimeMs: number;
	size: number;
}

interface VersionCacheEntry {
	schema: number;
	binPath: string;
	mtimeMs: number;
	size: number;
	version: string;
}

/** Injectable seams for tests; production callers pass nothing. */
export interface ClaudeCodeVersionDeps {
	/** Runs `<command> --version` and resolves with its stdout, or undefined on failure. */
	runVersionCommand?: (command: string) => Promise<string | undefined>;
	/** Resolves the installed CLI binary from PATH, or undefined when absent. */
	resolveBinary?: () => Promise<ResolvedClaudeBinary | undefined>;
	/** Cache file location (defaults to `<agentDir>/claude-code-version.json`). */
	cacheFilePath?: string;
}

function defaultRunVersionCommand(command: string): Promise<string | undefined> {
	return new Promise((resolve) => {
		// exec runs via the shell, so a Windows `claude.cmd` shim resolves (a bare
		// spawn would EINVAL on .cmd under Node >=20.12). `command` is a fixed
		// literal from VERSION_COMMANDS — no injection surface.
		exec(
			`${command} --version`,
			{ timeout: SPAWN_TIMEOUT_MS, encoding: "utf8", windowsHide: true },
			(error, stdout) => {
				resolve(error ? undefined : stdout);
			},
		);
	});
}

/** Parse "2.1.170 (Claude Code)" → "2.1.170"; undefined when unparseable. */
function parseVersionOutput(output: string): string | undefined {
	const first = output.trim().split(/\s+/)[0];
	return first && /^\d[\w.-]*$/.test(first) ? first : undefined;
}

/**
 * Resolve the installed CLI binary by scanning PATH in-process (stat calls,
 * no subprocess) — mirrors what the shell does for `claude --version`, and
 * yields the file identity (path+mtime+size) that keys the disk cache.
 */
async function resolveClaudeBinaryFromPath(): Promise<ResolvedClaudeBinary | undefined> {
	const pathEnv = process.env.PATH ?? "";
	const dirs = pathEnv.split(delimiter).filter(Boolean);
	const extensions =
		process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
	for (const name of VERSION_COMMANDS) {
		for (const dir of dirs) {
			for (const ext of extensions) {
				const candidate = join(dir, name + ext);
				try {
					const stats = await stat(candidate);
					if (stats.isFile()) {
						return { path: candidate, mtimeMs: stats.mtimeMs, size: stats.size };
					}
				} catch {
					// Missing/unreadable candidate — keep scanning.
				}
			}
		}
	}
	return undefined;
}

async function readVersionCache(cacheFilePath: string): Promise<VersionCacheEntry | undefined> {
	try {
		const raw = JSON.parse(await readFile(cacheFilePath, "utf8")) as Partial<VersionCacheEntry>;
		if (
			raw.schema === VERSION_CACHE_SCHEMA &&
			typeof raw.binPath === "string" &&
			typeof raw.mtimeMs === "number" &&
			typeof raw.size === "number" &&
			typeof raw.version === "string" &&
			parseVersionOutput(raw.version)
		) {
			return raw as VersionCacheEntry;
		}
	} catch {
		// Missing/corrupt cache — treated as a miss.
	}
	return undefined;
}

async function writeVersionCache(cacheFilePath: string, binary: ResolvedClaudeBinary, version: string): Promise<void> {
	try {
		const entry: VersionCacheEntry = {
			schema: VERSION_CACHE_SCHEMA,
			binPath: binary.path,
			mtimeMs: binary.mtimeMs,
			size: binary.size,
			version,
		};
		await mkdir(dirname(cacheFilePath), { recursive: true });
		await writeFile(cacheFilePath, `${JSON.stringify(entry, null, "\t")}\n`, "utf8");
	} catch {
		// Best-effort cache — next boot just re-detects.
	}
}

async function detectAndSetEnv(deps: ClaudeCodeVersionDeps): Promise<void> {
	const resolveBinary = deps.resolveBinary ?? resolveClaudeBinaryFromPath;
	const runVersionCommand = deps.runVersionCommand ?? defaultRunVersionCommand;
	const cacheEnabled = !isTruthyEnvFlag(process.env.PIT_NO_CLAUDE_VERSION_CACHE);
	const cacheFilePath = deps.cacheFilePath ?? join(getAgentDir(), VERSION_CACHE_FILE);

	let binary: ResolvedClaudeBinary | undefined;
	try {
		binary = await resolveBinary();
	} catch {
		binary = undefined;
	}

	// Cache hit (same binary file identity) — no spawn at all.
	if (binary && cacheEnabled) {
		const cached = await readVersionCache(cacheFilePath);
		if (
			cached &&
			cached.binPath === binary.path &&
			cached.mtimeMs === binary.mtimeMs &&
			cached.size === binary.size
		) {
			process.env.PIT_CLAUDE_CODE_VERSION = cached.version;
			return;
		}
	}

	for (const command of VERSION_COMMANDS) {
		let version: string | undefined;
		try {
			const output = await runVersionCommand(command);
			version = output ? parseVersionOutput(output) : undefined;
		} catch {
			// CLI missing / errored / timed out — try the next candidate, then fall
			// through so the provider keeps its static fallback.
		}
		if (version) {
			process.env.PIT_CLAUDE_CODE_VERSION = version;
			if (binary && cacheEnabled) {
				await writeVersionCache(cacheFilePath, binary, version);
			}
			return;
		}
	}
}

let inflight: Promise<void> | undefined;

/**
 * Populate PIT_CLAUDE_CODE_VERSION from the installed CLI when not already
 * pinned. Kick off early in boot (fire-and-forget) so detection overlaps with
 * module eval, then await the returned promise before the first model request.
 * Never rejects; when detection fails the env stays unset and the provider
 * keeps its static fallback. Single-flight: concurrent calls share one probe.
 */
export function ensureClaudeCodeVersionEnv(deps: ClaudeCodeVersionDeps = {}): Promise<void> {
	if (process.env.PIT_CLAUDE_CODE_VERSION?.trim()) {
		return Promise.resolve();
	}
	if (!inflight) {
		inflight = detectAndSetEnv(deps).catch(() => {});
	}
	return inflight;
}

/** Test-only: reset the single-flight state so assertions start from empty. */
export function __resetClaudeCodeVersionCacheForTests(): void {
	inflight = undefined;
}
