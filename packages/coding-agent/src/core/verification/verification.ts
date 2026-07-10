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
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree } from "../../utils/shell.ts";
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
/** Do not let a failed Windows tree-kill turn a verification timeout into a hang. */
const KILL_SETTLE_GRACE_MS = 3_000;

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

// ---------------------------------------------------------------------------
// Syntax/parse fallback — the last tier below detectCheckCommand.
//
// When a repo ships NO check/typecheck/lint/test script AND no locally-installed
// tsc, the gate would stay inert and a model (especially a weak one) could leave
// broken syntax with zero automatic signal. This builds a command that
// syntax-checks ONLY the files the turn touched, using interpreters that are
// either guaranteed present (node) or resolved on PATH first — so the gate never
// emits a "command not found" it would misread as a verification failure and loop
// the model on. Deliberately syntax-only (node --check / py_compile): no build, no
// test, no network, no config; scoped to touched files so it never surfaces
// pre-existing errors elsewhere in the repo. Fail-open: returns null on anything
// it can't safely check.
// ---------------------------------------------------------------------------

/** Cap how many files one fallback command checks, bounding command-line length. */
const MAX_SYNTAX_FALLBACK_FILES = 50;

/** Shell-safe cwd-relative path: alnum, dot, dash, underscore, forward slash only. */
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9._/-]+$/;

/**
 * First of `candidates` resolvable as an executable on PATH, or null. Returns the
 * bare candidate name (the shell re-resolves it) so the emitted command stays
 * portable. Probes the platform's executable extensions on Windows.
 */
function resolveExecutableOnPath(candidates: readonly string[]): string | null {
	const pathDirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
	const exeExts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
	for (const candidate of candidates) {
		for (const dir of pathDirs) {
			for (const ext of exeExts) {
				if (existsSync(join(dir, candidate + ext))) return candidate;
			}
		}
	}
	return null;
}

/**
 * Convert a touched-file path to a cwd-relative path safe to drop unquoted into a
 * shell command, or null when it is missing, outside `cwd`, or contains a space /
 * shell metacharacter (skipped rather than risk fragile cross-platform quoting).
 */
function toSafeRelativePath(file: string, cwd: string): string | null {
	if (typeof file !== "string" || file.length === 0) return null;
	const abs = isAbsolute(file) ? file : resolve(cwd, file);
	if (!existsSync(abs)) return null;
	const rel = relative(cwd, abs).split("\\").join("/");
	if (rel.length === 0 || rel.startsWith("..") || isAbsolute(rel)) return null;
	if (!SAFE_RELATIVE_PATH.test(rel)) return null;
	return rel;
}

/**
 * One syntax-only checker: the extensions it covers, the interpreter(s) to
 * resolve on PATH (null = always present, i.e. node), whether one invocation can
 * take many files (`batch`), and how to build the shell fragment. Every command
 * is PARSE-ONLY — no build, no execution, no network — so the gate stays a pure
 * syntax signal. A language whose interpreter does not resolve on PATH is
 * silently skipped: a "command not found" would be misread as a syntax failure
 * and loop the model on.
 */
interface SyntaxCheckLang {
	readonly exts: readonly string[];
	readonly interpreters: readonly string[] | null;
	readonly batch: boolean;
	readonly command: (exe: string, files: readonly string[]) => string;
}

const SYNTAX_CHECK_LANGS: readonly SyntaxCheckLang[] = [
	// node is always present (the agent runs on it). `node --check` validates ONE
	// file per invocation, so chain them. NOT applied to .ts/.tsx/.jsx — node
	// --check rejects type/JSX syntax and would false-fail valid sources; the tsc
	// fallback and the erasable-syntax guard already cover TypeScript.
	{
		exts: [".js", ".mjs", ".cjs"],
		interpreters: null,
		batch: false,
		command: (_exe, files) => `node --check ${files[0]}`,
	},
	// CPython's py_compile validates MANY files in one call.
	{
		exts: [".py"],
		interpreters: ["python3", "python"],
		batch: true,
		command: (exe, files) => `${exe} -m py_compile ${files.join(" ")}`,
	},
	// `ruby -c` checks syntax without executing — one file per invocation.
	{ exts: [".rb"], interpreters: ["ruby"], batch: false, command: (exe, files) => `${exe} -c ${files[0]}` },
	// `php -l` (lint) — one file per invocation.
	{ exts: [".php"], interpreters: ["php"], batch: false, command: (exe, files) => `${exe} -l ${files[0]}` },
	// `gofmt -e` parses and reports syntax errors (non-zero exit); a mere
	// formatting difference is NOT an error, so this stays syntax-only.
	{ exts: [".go"], interpreters: ["gofmt"], batch: false, command: (exe, files) => `${exe} -e ${files[0]}` },
	// `bash -n` parses a script without executing it.
	{ exts: [".sh", ".bash"], interpreters: ["bash"], batch: false, command: (exe, files) => `${exe} -n ${files[0]}` },
];

/**
 * Build a syntax-only check command for the turn's touched files, or null when
 * nothing is safely checkable. Used as the final fallback when detectCheckCommand
 * returns null. See the section comment above for the invariants.
 */
export function detectSyntaxFallbackCommand(cwd: string, touchedFiles: readonly string[]): string | null {
	if (!Array.isArray(touchedFiles) || touchedFiles.length === 0) return null;

	// Bucket every safely-relativizable touched file under the checker for its
	// extension (skipping paths that are missing / outside cwd / shell-unsafe).
	const filesByLang = new Map<SyntaxCheckLang, string[]>();
	for (const file of touchedFiles) {
		const rel = toSafeRelativePath(file, cwd);
		if (rel === null) continue;
		const ext = extname(rel).toLowerCase();
		const lang = SYNTAX_CHECK_LANGS.find((candidate) => candidate.exts.includes(ext));
		if (lang === undefined) continue;
		const list = filesByLang.get(lang);
		if (list) list.push(rel);
		else filesByLang.set(lang, [rel]);
	}
	if (filesByLang.size === 0) return null;

	const parts: string[] = [];
	let budget = MAX_SYNTAX_FALLBACK_FILES;
	// Deterministic table order so the emitted command is stable (JS, then py, …).
	for (const lang of SYNTAX_CHECK_LANGS) {
		if (budget <= 0) break;
		const files = filesByLang.get(lang);
		if (files === undefined || files.length === 0) continue;
		// Resolve the interpreter ONCE; skip the whole language when it is absent.
		let exe = "";
		if (lang.interpreters !== null) {
			const resolved = resolveExecutableOnPath(lang.interpreters);
			if (resolved === null) continue;
			exe = resolved;
		}
		const capped = files.slice(0, budget);
		if (lang.batch) {
			parts.push(lang.command(exe, capped));
		} else {
			for (const file of capped) parts.push(lang.command(exe, [file]));
		}
		budget -= capped.length;
	}

	if (parts.length === 0) return null;
	return parts.join(" && ");
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

	// Accumulate chunks in an array and only join+tail-slice when the buffered
	// total grows past 2× the cap, then once more at the end. The old code did
	// `output += chunk; output = output.slice(-CAP)` on EVERY chunk after the
	// cap was hit, allocating and copying a fresh ~64KB string per chunk — a GC
	// hotspot for verbose checks emitting megabytes. Compacting only at 2× the
	// cap amortizes the slice so it runs once per ~CAP bytes, not per chunk, and
	// bounds the in-flight buffer to <3× the cap. The retained tail is identical.
	const chunks: string[] = [];
	let bufferedLength = 0;
	let timedOut = false;
	const compact = () => {
		const joined = chunks.join("");
		const tail = joined.length > MAX_OUTPUT_BYTES ? joined.slice(-MAX_OUTPUT_BYTES) : joined;
		chunks.length = 0;
		chunks.push(tail);
		bufferedLength = tail.length;
	};
	const append = (text: string) => {
		if (text.length === 0) return;
		chunks.push(text);
		bufferedLength += text.length;
		if (bufferedLength > MAX_OUTPUT_BYTES * 2) compact();
	};
	// Decode each stream through its OWN StringDecoder so a multibyte UTF-8
	// sequence (pt-BR accents, box glyphs, emoji) split across two `data` events
	// is buffered until complete instead of being decoded as two halves — each
	// half would otherwise emit a U+FFFD replacement char (mojibake) that flows
	// into the gate failure summary and the re-injected prompt. Per-stream
	// decoders matter because a partial sequence at the tail of a stdout chunk is
	// only completed by the NEXT stdout chunk, never by an interleaved stderr one.
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	proc.stdout?.on("data", (chunk: Buffer) => append(stdoutDecoder.write(chunk)));
	proc.stderr?.on("data", (chunk: Buffer) => append(stderrDecoder.write(chunk)));

	let killTimer: NodeJS.Timeout | undefined;
	let forceSettleTimer: NodeJS.Timeout | undefined;
	let forceSettle: ((code: number) => void) | undefined;
	const kill = () => {
		const pid = proc.pid;
		try {
			if (process.platform === "win32" && pid !== undefined) {
				// `shell:true` runs cmd.exe; use the shared tree killer so descendants
				// receive both taskkill and its direct-kill fallback.
				killProcessTree(pid);
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
	const armForceSettle = () => {
		if (forceSettleTimer) return;
		forceSettleTimer = setTimeout(() => {
			// The tree-kill is best effort, but this API's timeout must be a hard
			// wall-clock boundary even if Windows refuses to reap a descendant.
			proc.stdout?.destroy();
			proc.stderr?.destroy();
			forceSettle?.(1);
		}, KILL_SETTLE_GRACE_MS);
	};

	const onAbort = () => {
		kill();
		armForceSettle();
	};
	if (opts?.signal) {
		if (opts.signal.aborted) kill();
		else opts.signal.addEventListener("abort", onAbort, { once: true });
	}
	if (opts?.timeoutMs && opts.timeoutMs > 0) {
		killTimer = setTimeout(() => {
			timedOut = true;
			kill();
			armForceSettle();
		}, opts.timeoutMs);
	}

	let exitCode: number;
	try {
		const childExit = waitForChildProcess(proc).then(
			(code) => code ?? 1,
			() => 1,
		);
		const forcedExit = new Promise<number>((resolve) => {
			forceSettle = resolve;
		});
		exitCode = await Promise.race([childExit, forcedExit]);
	} catch {
		exitCode = 1;
	} finally {
		if (killTimer) clearTimeout(killTimer);
		if (forceSettleTimer) clearTimeout(forceSettleTimer);
		opts?.signal?.removeEventListener("abort", onAbort);
	}

	// Flush any bytes still buffered inside the decoders (a final chunk that ended
	// mid-sequence). `.end()` emits the residual for a complete sequence, or a
	// single U+FFFD for a genuinely truncated trailing one — the right result for
	// output the process cut off, and it avoids silently dropping the tail.
	append(stdoutDecoder.end());
	append(stderrDecoder.end());
	compact();
	const output = chunks.length > 0 ? chunks[0] : "";
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
