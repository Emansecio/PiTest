/**
 * Turn-time verification primitives for the native verification gate.
 *
 * Detects a project's "is it still correct?" command and runs it. The gate
 * (AgentSession) uses these to check a code-modifying turn before reporting it
 * done, and to re-inject failures so the agent self-corrects. Pure I/O helpers
 * with no session/UI deps, so they unit-test on their own.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { waitForChildProcess } from "../../utils/child-process.ts";

/** Scripts tried in order — cheap correctness signals first, build/test excluded by default heaviness except `test` last. */
const CHECK_SCRIPT_PREFERENCE = ["check", "typecheck", "type-check", "lint", "test"] as const;

/** Cap captured output so a noisy check can't blow up memory or the prompt. */
const MAX_OUTPUT_BYTES = 64_000;

export interface CheckResult {
	ok: boolean;
	exitCode: number;
	/** Combined stdout+stderr, trimmed and tail-capped. */
	output: string;
	timedOut: boolean;
}

function detectPackageManager(cwd: string): string {
	if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
	if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
	return "npm";
}

/**
 * Best-effort detection of the project's check command from package.json scripts.
 * Returns e.g. "npm run check" / "pnpm run typecheck", or null when there is no
 * package.json or no recognizable script (gate then stays inert).
 */
export function detectCheckCommand(cwd: string): string | null {
	let scripts: Record<string, unknown> | undefined;
	try {
		const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, unknown> };
		scripts = pkg.scripts;
	} catch {
		return null;
	}
	if (!scripts || typeof scripts !== "object") return null;
	for (const name of CHECK_SCRIPT_PREFERENCE) {
		const body = scripts[name];
		if (typeof body === "string" && body.trim().length > 0) {
			return `${detectPackageManager(cwd)} run ${name}`;
		}
	}
	return null;
}

/**
 * Run a check command (a shell command string, e.g. "npm run check") in `cwd`.
 * Captures combined output, honors an abort signal and a timeout, and never
 * rejects — failures surface as `ok: false`.
 */
export async function runCheckCommand(
	command: string,
	cwd: string,
	opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<CheckResult> {
	const proc = spawn(command, {
		cwd,
		shell: true,
		stdio: ["ignore", "pipe", "pipe"],
		// POSIX: own process group so a timeout/abort can kill the whole tree.
		detached: process.platform !== "win32",
	});

	let output = "";
	let timedOut = false;
	const append = (chunk: Buffer) => {
		output += chunk.toString();
		if (output.length > MAX_OUTPUT_BYTES) output = output.slice(-MAX_OUTPUT_BYTES);
	};
	proc.stdout?.on("data", append);
	proc.stderr?.on("data", append);

	let killTimer: NodeJS.Timeout | undefined;
	const kill = () => {
		const pid = proc.pid;
		try {
			if (process.platform === "win32" && pid !== undefined) {
				// `shell:true` runs cmd.exe; killing it leaves the real child alive.
				// taskkill /T tears down the whole process tree.
				spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
			} else if (pid !== undefined) {
				process.kill(-pid, "SIGKILL"); // negative pid → kill the process group
			} else {
				proc.kill("SIGKILL");
			}
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}
	};

	const onAbort = () => kill();
	if (opts?.signal) {
		if (opts.signal.aborted) kill();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}
	if (opts?.timeoutMs && opts.timeoutMs > 0) {
		killTimer = setTimeout(() => {
			timedOut = true;
			kill();
		}, opts.timeoutMs);
	}

	let exitCode: number;
	try {
		exitCode = (await waitForChildProcess(proc)) ?? 1;
	} catch {
		exitCode = 1;
	} finally {
		if (killTimer) clearTimeout(killTimer);
		opts?.signal?.removeEventListener("abort", onAbort);
	}

	return { ok: exitCode === 0 && !timedOut, exitCode, output: output.trim(), timedOut };
}

// ---------------------------------------------------------------------------
// Module-level verification probe, mirroring the goal/todo manager registries.
// The active session publishes a one-shot check runner so tools (goal_complete)
// can refuse to finish while the project check is red, without per-call plumbing.
// Returns null when verification is disabled or no check command is configured.
// ---------------------------------------------------------------------------

let currentVerificationProbe: (() => Promise<CheckResult | null>) | undefined;

export function setCurrentVerificationProbe(probe: (() => Promise<CheckResult | null>) | undefined): void {
	currentVerificationProbe = probe;
}

export function getCurrentVerificationProbe(): (() => Promise<CheckResult | null>) | undefined {
	return currentVerificationProbe;
}
