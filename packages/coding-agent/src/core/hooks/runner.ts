/**
 * Spawn a hook command, pipe a JSON payload to stdin, parse stdout as JSON,
 * and return a structured result.
 */

import { spawn } from "node:child_process";
import { killProcessTreeAndWait } from "../../utils/shell.ts";
import {
	createRegexTestDeadline,
	isRegexBudgetExpired,
	testRegexWithinBudget,
	validateSafeRegex,
} from "../regex-budget.ts";
import { parseSimpleArgv } from "../simple-argv.ts";
import type { HookCommand, HookExecutionResult, HookPayload, HookResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const hookRegExpCache = new Map<string, RegExp | null>();

function matchTool(matcher: string | undefined, toolName: string, deadlineMs: number): boolean {
	if (!matcher) return true;
	if (isRegexBudgetExpired(deadlineMs)) return false;
	let re = hookRegExpCache.get(matcher);
	if (re === undefined) {
		try {
			validateSafeRegex(matcher);
			re = new RegExp(`^(?:${matcher})$`, "i");
		} catch {
			re = null;
		}
		hookRegExpCache.set(matcher, re);
	}
	if (!re) return matcher === toolName;
	const matched = testRegexWithinBudget(re, toolName, deadlineMs);
	if (matched === null) return false;
	return matched;
}

export function selectHooks(hooks: readonly HookCommand[] | undefined, toolName: string): HookCommand[] {
	if (!hooks || hooks.length === 0) return [];
	const deadline = createRegexTestDeadline();
	return hooks.filter((hook) => matchTool(hook.matcher, toolName, deadline));
}

function parseHookOutput(stdout: string): HookResult | undefined {
	const trimmed = stdout.trim();
	if (trimmed.length === 0) return undefined;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as HookResult;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export interface RunHookOptions {
	signal?: AbortSignal;
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

/**
 * Run a single hook command with the given JSON payload. Never throws on hook
 * failures — failures are returned in the result so the caller can decide how
 * to surface them.
 */
export async function runHook(
	hook: HookCommand,
	payload: HookPayload,
	options: RunHookOptions,
): Promise<HookExecutionResult> {
	const timeoutMs = hook.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const shell = hook.shell ?? true;
	const cwd = hook.cwd ?? options.cwd;
	const env = options.env ?? process.env;

	return new Promise<HookExecutionResult>((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = shell
				? spawn(hook.command, {
						cwd,
						env,
						shell: true,
						stdio: ["pipe", "pipe", "pipe"],
						detached: process.platform !== "win32",
					})
				: spawnDirect(hook.command, cwd, env);
		} catch (err) {
			resolve({
				hook,
				stdout: "",
				stderr: "",
				exitCode: -1,
				timedOut: false,
				rawError: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let stdout = "";
		let stderr = "";
		let resolved = false;
		let cleanup: Promise<boolean> | undefined;
		let termination: { exitCode: number; timedOut: boolean; rawError?: string } | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const finish = (exitCode: number, timedOut: boolean, rawError?: string) => {
			if (resolved) return;
			resolved = true;
			// Decode the accumulated Buffers ONCE. Decoding per-chunk would split a
			// multibyte UTF-8 sequence (emoji/CJK/PT-BR accent) that straddles two
			// 'data' chunks into broken halves, corrupting reason/additionalContext
			// before JSON.parse. Concat-then-decode reassembles the bytes correctly.
			stdout = Buffer.concat(stdoutChunks).toString("utf8") + stdout;
			stderr = Buffer.concat(stderrChunks).toString("utf8") + stderr;
			if (timer) clearTimeout(timer);
			if (options.signal) {
				options.signal.removeEventListener("abort", abort);
			}
			resolve({
				hook,
				stdout,
				stderr,
				exitCode,
				timedOut,
				parsed: parseHookOutput(stdout),
				...(rawError !== undefined ? { rawError } : {}),
			});
		};

		const kill = (): Promise<boolean> => {
			if (cleanup) return cleanup;
			cleanup = proc.pid
				? killProcessTreeAndWait(proc.pid).catch(() => false)
				: Promise.resolve().then(() => {
						try {
							return proc.kill("SIGKILL");
						} catch {
							return false;
						}
					});
			return cleanup;
		};

		const terminate = (exitCode: number, timedOut: boolean, rawError?: string) => {
			if (termination) return;
			termination = { exitCode, timedOut, rawError };
			void kill().then((cleaned) => {
				const cleanupError = cleaned ? undefined : "process tree cleanup did not complete";
				finish(exitCode, timedOut, rawError ?? cleanupError);
			});
		};

		const abort = () => terminate(-1, false);

		if (options.signal) {
			if (options.signal.aborted) {
				terminate(-1, false, "aborted");
				return;
			}
			options.signal.addEventListener("abort", abort, { once: true });
		}

		timer = setTimeout(() => {
			terminate(-1, true);
		}, timeoutMs);

		// A hook runs inline (awaited in beforeToolCall), so unbounded stdout/stderr
		// would grow the heap until OOM AND stall the session before the timeout
		// fires. Cap the combined output and kill the process when exceeded —
		// kill() settles via 'close'. Mirrors the OOM caps in bash/grep readers.
		const MAX_HOOK_OUTPUT_BYTES = 4 * 1024 * 1024;
		let outputBytes = 0;
		let outputCapped = false;
		const appendCapped = (chunk: Buffer, sink: "out" | "err") => {
			if (outputCapped) return;
			outputBytes += chunk.length;
			if (sink === "out") stdoutChunks.push(chunk);
			else stderrChunks.push(chunk);
			if (outputBytes > MAX_HOOK_OUTPUT_BYTES) {
				outputCapped = true;
				terminate(-1, false);
			}
		};
		proc.stdout?.on("data", (data) => {
			appendCapped(data, "out");
		});
		proc.stderr?.on("data", (data) => {
			appendCapped(data, "err");
		});

		proc.on("error", (err) => {
			// Capture the spawn-error text BEFORE resolving: finish() snapshots the
			// stderr closure at resolve time, so the previous order silently dropped
			// the ENOENT/EACCES message. Also surface it as rawError for logErrors().
			stderr += err.message;
			finish(-1, false, err.message);
		});

		proc.on("close", (code) => {
			if (termination) return;
			finish(code ?? 0, false);
		});

		// The hook may exit before draining stdin (e.g. early `exit 0`), closing the
		// pipe under our write. EPIPE arrives as an async 'error' event on the stdin
		// stream; without a listener Node treats it as fatal (uncaughtException →
		// process death). The try/catch only guards the synchronous throw.
		proc.stdin?.on("error", () => {
			/* stdin closed by the hook before we finished writing — non-fatal */
		});
		try {
			proc.stdin?.write(JSON.stringify(payload));
			proc.stdin?.end();
		} catch {
			/* stdin may already be closed if the process exited */
		}
	});
}

function spawnDirect(commandLine: string, cwd: string, env: NodeJS.ProcessEnv) {
	const parts = parseSimpleArgv(commandLine);
	if (!parts) {
		throw new Error("Direct hook command must contain one executable with quoted arguments and no shell operators");
	}
	const [cmd, ...args] = parts;
	if (!cmd) {
		throw new Error("Hook command is empty");
	}
	return spawn(cmd, args, {
		cwd,
		env,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
}

/**
 * Run a list of hooks sequentially. Stops at the first hook returning
 * `decision: "block"`. Returns the aggregate of executions plus the first
 * blocking result (if any).
 */
export async function runHookChain(
	hooks: readonly HookCommand[],
	payload: HookPayload,
	options: RunHookOptions,
): Promise<{ executions: HookExecutionResult[]; blocked: HookExecutionResult | undefined }> {
	const executions: HookExecutionResult[] = [];
	for (const hook of hooks) {
		const result = await runHook(hook, payload, options);
		executions.push(result);
		if (result.parsed?.decision === "block") {
			return { executions, blocked: result };
		}
		if (result.exitCode !== 0 && !result.parsed && payload.event === "PreToolUse") {
			// PreToolUse failures block by default — fail-closed for safety.
			return {
				executions,
				blocked: {
					...result,
					parsed: { decision: "block", reason: result.stderr.trim() || result.rawError || "hook exited non-zero" },
				},
			};
		}
	}
	return { executions, blocked: undefined };
}
