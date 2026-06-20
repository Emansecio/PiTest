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
import { extname, isAbsolute, join, resolve } from "node:path";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { getAvailableAdapters } from "../dap/config.ts";

/**
 * Locally-installed `tsc` fallback. When a TS project ships no `check`/
 * `typecheck` script the gate would stay inert and cross-file type errors only
 * surface when the user runs a check by hand. We fall back to the project's OWN
 * `tsc` binary — but only when it is already installed under node_modules/.bin,
 * so the gate never triggers an `npx` download or a "command not found" that it
 * would misread as a verification failure and loop the model on. Returns a
 * shell-ready command string or null.
 */
export function detectLocalTypecheckCommand(cwd: string): string | null {
	if (!existsSync(join(cwd, "tsconfig.json"))) return null;
	const isWindows = process.platform === "win32";
	const binName = isWindows ? "tsc.cmd" : "tsc";
	const binPath = join(cwd, "node_modules", ".bin", binName);
	if (!existsSync(binPath)) return null;
	// Return the cwd-RELATIVE path, not the quoted absolute one. runCheckCommand
	// spawns with `cwd`, so the relative path resolves the same — and because its
	// segments are fixed (node_modules/.bin/<bin>) it never contains spaces, so it
	// needs no quoting. The absolute form with a space in cwd is mis-parsed by
	// cmd.exe under `shell:true` on Windows (the quotes reach the shell literally).
	const relBin = join("node_modules", ".bin", binName);
	return `${relBin} --noEmit`;
}

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
	// No recognized script — fall back to the project's own locally-installed
	// tsc so the gate still catches cross-file type errors in TS repos.
	return detectLocalTypecheckCommand(cwd);
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
				const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
					stdio: "ignore",
					windowsHide: true,
				});
				// If taskkill can't start (PATH without System32, renamed/missing binary) the
				// failure arrives as an async 'error' event; without a listener Node makes it
				// fatal (uncaughtException). This runs on the timeout/abort recovery path, so a
				// crash here would defeat the very kill it's performing.
				killer.on("error", () => {});
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

// ---------------------------------------------------------------------------
// Debug-driven verify: detect whether the just-passed check has a runtime repro
// that a native debugger can step through to confirm the fix actually covers the
// path (not just that it type-checks / lints). Deliberately RESTRICTED to two
// robust ecosystems — pytest+debugpy and `go test`+dlv — where the entry point is
// inferable from a touched test file and the adapter resolves locally. Anything
// else returns null and the caller falls back to the check-based gate (fail-open).
// ---------------------------------------------------------------------------

/** Ecosystem the debug-verify launch will drive. Restrict to vetted pairs only. */
export type DebuggableEcosystem = "pytest" | "go-test";

export interface DebuggableRepro {
	ecosystem: DebuggableEcosystem;
	/** DAP adapter name resolved as available in `cwd` (e.g. "debugpy", "dlv"). */
	adapter: string;
	/**
	 * Launch target used for adapter resolution and session display. For pytest this
	 * is the absolute `.py` test file; for go-test the absolute package directory of
	 * the touched `_test.go` file. The launch routine passes this to
	 * `selectLaunchAdapter` + `dapSessionManager.launch`.
	 */
	program: string;
	/**
	 * When set, debugpy is launched in MODULE mode (`python -m <module>`), i.e. the
	 * DAP request carries `module` and NOT `program`. This is mandatory for pytest:
	 * launching the test file as a script (program=test.py) makes debugpy run it with
	 * Python directly — a typical pytest file has no `__main__`, so nothing executes
	 * and the breakpoint is never reached (the verdict is then always inconclusive).
	 * Module mode invokes `pytest` properly with the test file passed in `args`.
	 */
	module?: string;
	/** Extra program/module args (e.g. the test file path + pytest flags). */
	args: string[];
	/** The source file the breakpoint should target (absolute). */
	breakpointFile: string;
	/**
	 * 1-based line in `breakpointFile` the breakpoint should bind to. When the wire
	 * knows the exact touched fix line it passes it via `withFixSite()`; otherwise
	 * this stays undefined and the launch sets a function/whole-file breakpoint
	 * fallback (see debug-verify). Line 1 is deliberately NOT used as a default — for
	 * pytest the breakpoint file is the test file and line 1 is rarely an executable
	 * statement, so a line-1 breakpoint binds to module-top locals (empty), never the
	 * function under fix.
	 */
	breakpointLine?: number;
}

/**
 * Refine a repro with the exact fix site (source file + 1-based line) the turn
 * touched, so the breakpoint binds to the corrected statement instead of the top of
 * the test file. The wire (agent-session) calls this when it tracked a single
 * dominant edit location; pass the SOURCE file that was fixed, not the test file.
 * Returns a new repro (does not mutate). No-ops to the input when inputs are invalid.
 */
export function withFixSite(repro: DebuggableRepro, file: string, line: number, cwd: string): DebuggableRepro {
	if (typeof file !== "string" || file.length === 0) return repro;
	if (!Number.isInteger(line) || line < 1) return repro;
	const ext = extname(file).toLowerCase();
	// Only retarget to a file the repro's ecosystem can meaningfully break in.
	const allowed = repro.ecosystem === "pytest" ? ext === ".py" : ext === ".go";
	if (!allowed) return repro;
	return { ...repro, breakpointFile: toAbsolute(file, cwd), breakpointLine: line };
}

const PYTEST_TEST_FILE_RE = /(^|[\\/])(test_[^\\/]+|[^\\/]+_test)\.py$/i;
const GO_TEST_FILE_RE = /_test\.go$/i;

function toAbsolute(file: string, cwd: string): string {
	return isAbsolute(file) ? resolve(file) : resolve(cwd, file);
}

function hasAdapter(cwd: string, name: string): boolean {
	try {
		return getAvailableAdapters(cwd).some((adapter) => adapter.name === name);
	} catch {
		return false;
	}
}

/**
 * Recognize the happy path for debug-driven verify. Returns a launchable repro or
 * null. NEVER throws — any inference failure degrades to the check-based gate.
 *
 * `touchedFiles` are the files the turn modified (absolute or cwd-relative).
 * `checkResult` is the already-PASSED result; we only proceed when ok=true (a red
 * check is the existing gate's job, debug-verify is purely additive on green).
 *
 * Restriction rationale: we only launch when (a) the adapter binary resolves in
 * `cwd` AND (b) a touched file is unambiguously a pytest/go test, so the entry
 * point and breakpoint are derivable without guessing a main()/CLI.
 */
export function isDebuggableRepro(
	touchedFiles: readonly string[],
	checkResult: CheckResult,
	cwd: string,
): DebuggableRepro | null {
	try {
		if (!checkResult.ok) return null;
		if (!Array.isArray(touchedFiles) || touchedFiles.length === 0) return null;

		// pytest + debugpy: a touched test_*.py / *_test.py file, adapter present.
		const pyTest = touchedFiles.find(
			(file) => typeof file === "string" && extname(file).toLowerCase() === ".py" && PYTEST_TEST_FILE_RE.test(file),
		);
		if (pyTest && hasAdapter(cwd, "debugpy")) {
			const program = toAbsolute(pyTest, cwd);
			return {
				ecosystem: "pytest",
				adapter: "debugpy",
				// MODULE launch (`python -m pytest <testfile>`): the launch routine sends
				// `module: "pytest"` (NOT `program`) so debugpy actually invokes pytest as
				// a module against the single touched test file — fast, scoped, and unlike
				// a script launch it runs the tests regardless of a `__main__`. The `args`
				// here are the pytest argv, NOT a `-m pytest` prefix (the adapter prepends
				// the module). `-p no:cacheprovider` keeps it stateless across runs.
				program,
				module: "pytest",
				args: [program, "-p", "no:cacheprovider", "-x", "-q"],
				// Default breakpoint target is the test file. The wire SHOULD refine this
				// to the fixed source file:line via `withFixSite` so the breakpoint binds
				// to the corrected statement, not the top of the test module.
				breakpointFile: program,
			};
		}

		// go test + dlv: a touched *_test.go file, dlv present. dlv launches the
		// package directory in test mode.
		const goTest = touchedFiles.find((file) => typeof file === "string" && GO_TEST_FILE_RE.test(file));
		if (goTest && hasAdapter(cwd, "dlv")) {
			const abs = toAbsolute(goTest, cwd);
			const pkgDir = abs.replace(/[\\/][^\\/]+$/, "");
			return {
				ecosystem: "go-test",
				adapter: "dlv",
				program: pkgDir,
				args: [],
				breakpointFile: abs,
			};
		}

		return null;
	} catch {
		return null;
	}
}
