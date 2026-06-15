import { execSync } from "node:child_process";

// Anthropic routes Pro/Max OAuth traffic by the Claude Code fingerprint, and the
// spoofed user-agent VERSION is part of it. A version too far behind the actual
// release gets intermittent 5xx (overloaded_error) on OAuth traffic — worst on
// the newest models. The provider (@pit/ai) carries a static fallback; this
// Node-only helper detects the installed CLI so the spoofed version tracks the
// real release instead of going stale. (@pit/ai can't run a subprocess — it is
// covered by the browser smoke build.)

let cached: string | undefined;

/**
 * Detect the installed Claude Code CLI version (e.g. "2.1.170"). Best-effort,
 * cached, never throws; returns undefined when the CLI is absent or its output
 * is unparseable. `claude --version` prints like "2.1.170 (Claude Code)".
 */
export function detectClaudeCodeVersion(): string | undefined {
	if (cached !== undefined) return cached || undefined;
	cached = "";
	for (const cmd of ["claude", "claude-code"]) {
		try {
			// execSync runs via the shell, so a Windows `claude.cmd` shim resolves
			// (a bare spawn would EINVAL on .cmd under Node >=20.12). `cmd` is a
			// fixed literal — no injection surface.
			const out = execSync(`${cmd} --version`, {
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 3000,
				encoding: "utf8",
				windowsHide: true,
			});
			const first = out.trim().split(/\s+/)[0];
			if (first && /^\d[\w.-]*$/.test(first)) {
				cached = first;
				return first;
			}
		} catch {
			// CLI missing / errored / timed out — try the next candidate, then
			// fall through to undefined so the provider keeps its static fallback.
		}
	}
	return undefined;
}

/**
 * Populate PIT_CLAUDE_CODE_VERSION from the installed CLI when not already pinned.
 * Call once at boot, before the first model request. No-op when the env var is
 * already set (explicit override) or detection fails. The `detect` parameter is
 * injectable for tests.
 */
export function ensureClaudeCodeVersionEnv(detect: () => string | undefined = detectClaudeCodeVersion): void {
	if (process.env.PIT_CLAUDE_CODE_VERSION?.trim()) return;
	const detected = detect();
	if (detected) {
		process.env.PIT_CLAUDE_CODE_VERSION = detected;
	}
}

/** Test-only: reset the detection cache so assertions start from empty. */
export function __resetClaudeCodeVersionCacheForTests(): void {
	cached = undefined;
}
