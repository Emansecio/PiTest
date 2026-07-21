import { existsSync } from "node:fs";
import { basename, delimiter } from "node:path";
import { recordDiagnostic } from "@pit/ai";
import { spawn, spawnSync } from "child_process";
import { getBinDir } from "../config.ts";

export interface ShellConfig {
	shell: string;
	args: string[];
}

/**
 * POSIX shells whose command-string executable (bash -c "...") is a superset
 * of `sh`, so a bare `eval` of a fully-buffered string behaves the same as
 * passing that string directly as the -c argument. Used to gate the bash
 * tool's pre-warmed spare-shell pool (see bash.ts): cmd.exe / PowerShell have
 * neither `-c`-style single-command semantics nor `eval`, so they are never
 * matched here and always take the direct-spawn path.
 */
const POSIX_SHELL_BASENAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);

/** Whether `shellPath` resolves to a POSIX-family shell (bash/sh/zsh/...),
 * identified by executable basename (case-insensitive, `.exe` stripped) — the
 * same shells `getShellConfig` invokes with `-c` on every platform. */
export function isPosixShellPath(shellPath: string): boolean {
	const base = basename(shellPath)
		.toLowerCase()
		.replace(/\.exe$/, "");
	return POSIX_SHELL_BASENAMES.has(base);
}

/**
 * Find bash executable on PATH (cross-platform)
 */
function findBashOnPath(): string | null {
	if (process.platform === "win32") {
		// Windows: Use 'where' and verify file exists (where can return non-existent paths)
		try {
			const result = spawnSync("where", ["bash.exe"], {
				encoding: "utf-8",
				// Bound event-loop stall on first shell resolve (result is cached).
				timeout: 2000,
				windowsHide: true,
			});
			if (result.status === 0 && result.stdout) {
				const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
				if (firstMatch && existsSync(firstMatch)) {
					return firstMatch;
				}
			}
		} catch {
			// Ignore errors
		}
		return null;
	}

	// Unix: Use 'which' and trust its output (handles Termux and special filesystems)
	try {
		const result = spawnSync("which", ["bash"], { encoding: "utf-8", timeout: 2000 });
		if (result.status === 0 && result.stdout) {
			const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
			if (firstMatch) {
				return firstMatch;
			}
		}
	} catch {
		// Ignore errors
	}
	return null;
}

/**
 * Resolve shell configuration based on platform and an optional explicit shell path.
 * Resolution order:
 * 1. User-specified shellPath
 * 2. On Windows: Git Bash in known locations, then bash on PATH
 * 3. On Unix: /bin/bash, then bash on PATH, then fallback to sh
 */
const shellConfigCache = new Map<string, ShellConfig>();

export function getShellConfig(customShellPath?: string): ShellConfig {
	const cacheKey = customShellPath ?? "";
	const cached = shellConfigCache.get(cacheKey);
	if (cached) return cached;
	const config = resolveShellConfig(customShellPath);
	shellConfigCache.set(cacheKey, config);
	return config;
}

function resolveShellConfig(customShellPath?: string): ShellConfig {
	if (customShellPath) {
		if (existsSync(customShellPath)) {
			return { shell: customShellPath, args: ["-c"] };
		}
		throw new Error(`Custom shell path not found: ${customShellPath}`);
	}

	if (process.platform === "win32") {
		const paths: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) {
			paths.push(`${programFiles}\\Git\\bin\\bash.exe`);
		}
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) {
			paths.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		}

		for (const path of paths) {
			if (existsSync(path)) {
				return { shell: path, args: ["-c"] };
			}
		}

		const bashOnPath = findBashOnPath();
		if (bashOnPath) {
			return { shell: bashOnPath, args: ["-c"] };
		}

		throw new Error(
			`No bash shell found. Options:\n` +
				`  1. Install Git for Windows: https://git-scm.com/download/win\n` +
				`  2. Add your bash to PATH (Cygwin, MSYS2, etc.)\n` +
				"  3. Set shellPath in settings.json\n\n" +
				`Searched Git Bash in:\n${paths.map((p) => `  ${p}`).join("\n")}`,
		);
	}

	if (existsSync("/bin/bash")) {
		return { shell: "/bin/bash", args: ["-c"] };
	}

	const bashOnPath = findBashOnPath();
	if (bashOnPath) {
		return { shell: bashOnPath, args: ["-c"] };
	}

	return { shell: "sh", args: ["-c"] };
}

// Cached for the lifetime of the process: PATH/env mutations that happen mid-session
// (e.g. a tool installer prepending to PATH, or `config` writing a new PYTHONUTF8)
// never reach subsequent bash children, only ones spawned before the first call here.
// Deliberate — every `spawn(..., { env: getShellEnv() })` call site wants a stable,
// cheap-to-read snapshot rather than paying the lookup+merge cost per command; the
// env vars involved (bin dir on PATH, Python UTF-8 flags) are set once at startup in
// practice. Revisit with an explicit invalidation hook if a future feature needs
// live PATH changes to propagate to already-running sessions.
let _cachedShellEnv: NodeJS.ProcessEnv | undefined;

export function getShellEnv(): NodeJS.ProcessEnv {
	if (_cachedShellEnv) return _cachedShellEnv;

	const binDir = getBinDir();
	const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const currentPath = process.env[pathKey] ?? "";
	const pathEntries = currentPath.split(delimiter).filter(Boolean);
	const hasBinDir = pathEntries.includes(binDir);
	const updatedPath = hasBinDir ? currentPath : [binDir, currentPath].filter(Boolean).join(delimiter);

	_cachedShellEnv = {
		...process.env,
		[pathKey]: updatedPath,
		PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
		PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
	};
	return _cachedShellEnv;
}

/**
 * Sanitize binary output for display/storage.
 * Removes characters that crash string-width or cause display issues:
 * - Control characters (except tab, newline, carriage return)
 * - Lone surrogates
 * - Unicode Format characters (crash string-width due to a bug)
 * - Characters with undefined code points
 */
const SANITIZE_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f￹-￻]/g;

export function sanitizeBinaryOutput(str: string): string {
	return str.replace(SANITIZE_RE, "");
}

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

// Grace window for taskkill to actually remove the tree before we double-check
// and fall back to a direct kill. taskkill is spawned fire-and-forget above (we
// only listen for its own spawn 'error', never its exit code), so a silent
// no-op — wrong PATH resolving a different taskkill, ERROR_ACCESS_DENIED, a pid
// that was already a zombie — would otherwise go unnoticed by every caller that
// assumes the tree is gone once this function returns.
const KILL_VERIFY_DELAY_MS = 2_000;

/**
 * Kill a process and all its children (cross-platform)
 */
export function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		// Use taskkill on Windows to kill process tree
		try {
			const killer = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
			// If taskkill can't start (PATH without System32, renamed/missing binary) the
			// failure arrives as an async 'error' event; without a listener Node makes it
			// fatal (uncaughtException). This runs on the kill/abort/shutdown paths, so a
			// crash here would defeat the very recovery it's part of.
			killer.on("error", () => {});
			// Verify the target actually died; taskkill's own failure modes above are
			// swallowed, so a caller (bash.ts's timeout/abort paths) relying on the
			// process actually exiting could otherwise wait forever. Fall back to a
			// direct kill if it's still around after a short grace window.
			const verifyTimer = setTimeout(() => {
				// Signal 0 sends nothing; it throws ESRCH once the pid is gone (verified on
				// both POSIX and Windows — Node forwards signal 0 to a real existence check
				// on Win32 too, unlike other signal numbers which unconditionally terminate).
				let stillAlive = true;
				try {
					process.kill(pid, 0);
				} catch {
					stillAlive = false;
				}
				if (!stillAlive) return; // taskkill worked, or the process already exited on its own
				// Second taskkill /T attempt — process.kill(pid) alone only kills the
				// root PID and orphans grandchildren (CPU, cwd locks). Prefer tree kill.
				try {
					const retry = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
						stdio: "ignore",
						detached: true,
						windowsHide: true,
					});
					retry.on("error", () => {});
				} catch (err) {
					// taskkill missing entirely — last-resort single-PID kill.
					try {
						process.kill(pid);
					} catch (killErr) {
						recordDiagnostic({
							category: "process.kill",
							level: "error",
							source: "shell.killProcessTree.fallback",
							context: {
								pid,
								note:
									killErr instanceof Error
										? killErr.message
										: err instanceof Error
											? err.message
											: String(killErr),
							},
						});
					}
				}
			}, KILL_VERIFY_DELAY_MS);
			verifyTimer.unref?.();
		} catch {
			// Ignore errors if taskkill fails
		}
	} else {
		// Use SIGKILL on Unix/Linux/Mac
		try {
			process.kill(-pid, "SIGKILL");
		} catch {
			// Fallback to killing just the child if process group kill fails
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Process already dead
			}
		}
	}
}
