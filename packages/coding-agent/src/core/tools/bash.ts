import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { AgentTool } from "@pit/agent-core";
import { recordDiagnostic } from "@pit/ai";
import { Container, Text, truncateToWidth } from "@pit/tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { clampBashCommandRow } from "../../modes/interactive/components/bash-command-row.ts";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.js";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.js";
import { summarizeTestRun } from "../verification/test-summary.ts";
import { applyKeyAliases } from "./argument-prep.js";
import { classifyBashCommand } from "./bash-activity.js";
import { isJsonCrushEnabled, maybeCrushJsonOutput } from "./json-crush.js";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.js";
import { getTextOutput, invalidArgText, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import {
	BASH_HEAD_MAX_BYTES,
	BASH_HEAD_MAX_LINES,
	BASH_MAX_BYTES,
	BASH_MAX_LINES,
	collapseRepeatedLines,
	formatSize,
	type TruncationResult,
} from "./truncate.js";

const bashSchema = Type.Object(
	{
		command: Type.String({ description: "Bash command to execute" }),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory for this command — absolute, or relative to the session root. Defaults to the session root. Prefer this over a leading `cd …` so the command line stays clean.",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				description:
					"Timeout in seconds. Without a timeout (or 0) the command runs to completion. For servers and long-running processes, prefer `background: true` over holding the shell. Never leave a command that may block on interactive input without a timeout.",
			}),
		),
		background: Type.Optional(
			Type.Boolean({
				description:
					"Start the command in the background and return immediately with a job id (dev servers, watchers, long builds). Output up to the hand-off is returned; later output and the exit code are buffered under the id. A command that finishes (or errors) within the brief startup window returns normally instead. Preferred over `cmd &`, which yields an untracked process with no id.",
			}),
		),
	},
	{ additionalProperties: false },
);

// Aliases for common LLM mistakes. `cmd` and `script` are the two most-seen
// variants in production traces; `commands` (array form) is normalized by
// joining with ' && ' so we still hit a single shell invocation.
const BASH_KEY_ALIASES = {
	cmd: "command",
	script: "command",
	shell: "command",
	run: "command",
	dir: "cwd",
	directory: "cwd",
	workdir: "cwd",
	working_directory: "cwd",
} as const;

export function prepareBashArguments(input: unknown): BashToolInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return input as BashToolInput;
	let args = applyKeyAliases(input as Record<string, unknown>, BASH_KEY_ALIASES);
	// `commands: ["a", "b"]` -> `command: "a && b"`. Only triggers when canonical
	// `command` is absent so we never overwrite a string argument.
	if (Array.isArray((args as Record<string, unknown>).commands) && typeof args.command !== "string") {
		const commands = (args as Record<string, unknown>).commands as unknown[];
		if (commands.every((item) => typeof item === "string")) {
			const next = { ...args } as Record<string, unknown>;
			next.command = (commands as string[]).join(" && ");
			delete next.commands;
			args = next;
		}
	}
	// Trim whitespace the model sometimes wraps the command in ("  npm run build  ");
	// it reaches the shell literally otherwise. bash-grounding/simple-argv already
	// trim for parsing — this aligns execution. Clone only when it changes so a clean
	// command keeps its reference. Surrounding whitespace is never shell-significant.
	const withCommand = args as Record<string, unknown>;
	if (typeof withCommand.command === "string") {
		const trimmed = withCommand.command.trim();
		if (trimmed !== withCommand.command) {
			args = { ...withCommand, command: trimmed } as BashToolInput;
		}
	}
	return args as BashToolInput;
}

// Sanitize the model-supplied timeout without imposing a low ceiling: legitimate
// long-running commands (builds, test suites) are expected to run without a limit.
// `undefined` / `<= 0` / non-finite => no limit (returns undefined). Otherwise
// round to a whole second and clamp the upper bound only to reject absurd values
// (24h), never to cut real workloads.
function normalizeBashTimeout(timeout: number | undefined): number | undefined {
	if (typeof timeout !== "number" || !Number.isFinite(timeout)) return undefined;
	const seconds = Math.round(timeout);
	if (seconds <= 0) return undefined;
	return Math.min(86400, seconds);
}

export type BashToolInput = Static<typeof bashSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
	/** Compiled test-runner headline (e.g. "✓ 142 passed") shown as a footer chip. */
	testSummary?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Resolves to the exit code (null if killed). When `promotedJobId` is
	 *   set, the command did NOT finish — it crossed the auto-background threshold
	 *   and was detached into a tracked background job; the process is still alive
	 *   under that id (poll/kill via the background-job registry), `exitCode` is
	 *   null, and the caller should surface the partial output collected so far.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			/** Command label used for the background-job record on promotion. */
			label?: string;
			/**
			 * Opt IN to auto-backgrounding. When true, a command WITHOUT an explicit
			 * `timeout` that outruns the threshold is promoted to a tracked background
			 * job (the caller MUST read `promotedJobId`). Default OFF: the command runs
			 * to completion (or is killed by `timeout`) and is never silently detached.
			 * The agent's `bash` tool sets this; the user `!` path (bash-executor) does
			 * not — it reads only `exitCode`, so a silent promotion there would leave a
			 * detached process with no reachable handle.
			 */
			autoBackground?: boolean;
			/**
			 * Background the command on request: promote to a tracked job after a brief
			 * startup window (so an immediate failure still surfaces in the foreground)
			 * regardless of `autoBackground`/`timeout`. The caller MUST read
			 * `promotedJobId`. Used by the `bash` tool's `background: true` param.
			 */
			backgroundImmediate?: boolean;
		},
	) => Promise<{ exitCode: number | null; promotedJobId?: string }>;
}

// Default auto-background threshold (seconds). A synchronous command WITHOUT an
// explicit `timeout` that runs longer than this is PROMOTED to a tracked
// background job instead of being killed — builds/dev-servers/long scans keep
// running and the model gets a handle + the output captured so far. An explicit
// `timeout` is honored verbatim as a hard kill (idle-real death), never promoted.
// Override with PIT_BASH_AUTO_BACKGROUND_SECONDS; set to 0 / a non-positive
// value to disable auto-backgrounding (commands without a timeout run forever).
const BASH_AUTO_BACKGROUND_SECONDS = 60;

// Startup window for an explicit `background: true` request. The command is given
// this long to fail fast (bad flag, missing binary) in the foreground; if it is
// still running afterwards it is promoted to a tracked job. Override with
// PIT_BASH_BACKGROUND_STARTUP_MS.
const BASH_BACKGROUND_STARTUP_MS = 250;

function resolveBackgroundStartupMs(): number {
	const raw = process.env.PIT_BASH_BACKGROUND_STARTUP_MS;
	if (raw === undefined || raw === "") return BASH_BACKGROUND_STARTUP_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n >= 0 ? n : BASH_BACKGROUND_STARTUP_MS;
}

function resolveAutoBackgroundSeconds(): number {
	const raw = process.env.PIT_BASH_AUTO_BACKGROUND_SECONDS;
	if (raw === undefined || raw === "") return BASH_AUTO_BACKGROUND_SECONDS;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return parsed;
}

// Per-job ring-buffer cap for output captured AFTER promotion. Bounds memory so a
// chatty detached process (a dev-server logging forever) can't grow the registry
// without limit. Oldest bytes are dropped first; the pre-promotion output the
// model already saw is unaffected (it lives in the caller's accumulator).
const BASH_BG_RING_MAX_BYTES = 256 * 1024;
// Absolute ceiling on concurrently tracked background jobs. Beyond this, the
// oldest finished job is evicted (and, if still running, its tree is killed) so
// the registry can never leak unboundedly across a long session.
const BASH_BG_MAX_JOBS = 32;

/**
 * A command promoted to the background after crossing the auto-background
 * threshold. Stays tracked via `trackDetachedChildPid` so the existing
 * shutdown reaper (`killTrackedDetachedChildren`) kills it on exit — promotion
 * deliberately does NOT untrack the pid. The ring buffer keeps post-promotion
 * output under a byte cap for later polling.
 */
export interface BashBackgroundJob {
	id: string;
	pid: number | undefined;
	command: string;
	startedAt: number;
	promotedAt: number;
	exited: boolean;
	exitCode: number | null;
	/** Bounded post-promotion output (oldest bytes dropped past the cap). */
	ringBuffer: string;
	ringTruncated: boolean;
	kill: () => void;
}

const backgroundJobs = new Map<string, BashBackgroundJob>();
let backgroundJobSeq = 0;

/** Snapshot of currently tracked background jobs (poll surface for callers). */
export function listBashBackgroundJobs(): BashBackgroundJob[] {
	return [...backgroundJobs.values()];
}

/** Look up a single promoted background job by id. */
export function getBashBackgroundJob(id: string): BashBackgroundJob | undefined {
	return backgroundJobs.get(id);
}

/** Kill a promoted background job's tree and drop it from the registry. */
export function killBashBackgroundJob(id: string): boolean {
	const job = backgroundJobs.get(id);
	if (!job) return false;
	job.kill();
	backgroundJobs.delete(id);
	return true;
}

// Test-only reset so suites don't leak registry state across cases. No prod path
// calls this; shutdown cleanup goes through killTrackedDetachedChildren by pid.
export function _resetBashBackgroundJobsForTest(): void {
	backgroundJobs.clear();
	backgroundJobSeq = 0;
}

// Test-only: seed the registry with a synthetic job so suites can exercise the
// pending-check guards without spawning a real long-running process.
export function _registerBashBackgroundJobForTest(job: BashBackgroundJob): void {
	backgroundJobs.set(job.id, job);
}

function registerBackgroundJob(job: BashBackgroundJob): void {
	// Evict the oldest already-exited job first; if all are still running and we're
	// at the ceiling, evict (and kill) the oldest to bound the registry.
	while (backgroundJobs.size >= BASH_BG_MAX_JOBS) {
		const oldestExited = [...backgroundJobs.values()].find((j) => j.exited);
		const victim = oldestExited ?? backgroundJobs.values().next().value;
		if (!victim) break;
		if (!victim.exited) victim.kill();
		backgroundJobs.delete(victim.id);
	}
	backgroundJobs.set(job.id, job);
}

/**
 * Create bash operations using pi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want pi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: (command, cwd, { onData, signal, timeout, env, label, autoBackground, backgroundImmediate }) => {
			return new Promise((resolve, reject) => {
				const { shell, args } = getShellConfig(options?.shellPath);
				if (!existsSync(cwd)) {
					reject(new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`));
					return;
				}
				const child = spawn(shell, [...args, command], {
					cwd,
					detached: process.platform !== "win32",
					env: env ?? getShellEnv(),
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				if (child.pid) trackDetachedChildPid(child.pid);
				const startedAt = Date.now();
				let timedOut = false;
				let timeoutHandle: NodeJS.Timeout | undefined;
				// Set hard timeout if the caller asked for one. An explicit timeout is
				// an intent to KILL (idle-real death) — it is never auto-backgrounded.
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						recordDiagnostic({
							category: "process.kill",
							level: "warn",
							source: "bash.timeout",
							context: { pid: child.pid },
						});
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}

				// Auto-background: opt-in (`autoBackground`) AND only for commands with NO
				// explicit hard timeout. When such a command outruns the threshold we
				// PROMOTE it to a tracked background job (keeping it alive + detached)
				// instead of holding the shell forever. The pid stays in
				// `trackDetachedChildPid` so the shutdown reaper still kills it —
				// promotion does not untrack. Callers that do NOT read `promotedJobId`
				// (the user `!` path via bash-executor) leave this OFF so a long command
				// is never silently detached out from under them — it runs to completion
				// or is killed by an explicit timeout, exactly as before.
				const autoBgSeconds = autoBackground === true ? resolveAutoBackgroundSeconds() : 0;
				let promoted: BashBackgroundJob | undefined;
				let autoBgHandle: NodeJS.Timeout | undefined;
				const settled = { done: false };

				const killTree = () => {
					if (child.pid) killProcessTree(child.pid);
				};

				// Handle abort signal by killing the entire process tree. Declared before
				// `promoteToBackground` so the latter can detach it on promotion (a
				// backgrounded process must survive a tool-call abort).
				const onAbort = () => {
					recordDiagnostic({
						category: "process.kill",
						level: "info",
						source: "bash.abort",
						context: { pid: child.pid },
					});
					// Cancel a pending promotion and lock it out. The promotion timer
					// (autoBgHandle) is only cleared by waitForChildProcess's resolution
					// (lines below); if the death event lags the timer after an abort fires
					// in the startup window, promoteToBackground would otherwise run — its
					// only guard is `if (settled.done) return`, and settled.done was still
					// false on abort. That registered a background job for a dying pid and
					// resolved the foreground promise with a "still running" handle instead
					// of rejecting with "aborted". Marking settled.done + clearing the timer
					// here keeps the abort authoritative: the real "aborted" rejection comes
					// from the waitForChildProcess path (signal?.aborted) below.
					settled.done = true;
					if (autoBgHandle) clearTimeout(autoBgHandle);
					killTree();
				};

				const promoteToBackground = () => {
					if (settled.done) return;
					backgroundJobSeq += 1;
					const id = `bg-${backgroundJobSeq}`;
					const job: BashBackgroundJob = {
						id,
						pid: child.pid,
						command: label ?? command,
						startedAt,
						promotedAt: Date.now(),
						exited: false,
						exitCode: null,
						ringBuffer: "",
						ringTruncated: false,
						kill: killTree,
					};
					promoted = job;
					registerBackgroundJob(job);
					// NOTE: no runtime-diagnostics event is recorded on promotion. The
					// closed DiagnosticCategory union is owned by @pit/ai (out of this lane)
					// and has no "promoted"/"background" member; reusing an existing
					// category would corrupt its last-write-wins counter level for unrelated
					// callers. The observable surface for a promotion is the returned tool
					// message + the queryable registry (listBashBackgroundJobs). A dedicated
					// `process.background` category in @pit/ai is a clean follow-up.
					// Stop feeding the caller's `onData`: the foreground tool call is about
					// to finish its accumulator, and appending to it post-finish throws.
					// Post-promotion output goes only into the bounded ring buffer below.
					child.stdout?.off("data", onData);
					child.stderr?.off("data", onData);
					// Keep capturing output into a bounded ring buffer for later polling.
					// The pre-promotion bytes already went to the caller via `onData`.
					const appendRing = (data: Buffer) => {
						job.ringBuffer += data.toString("utf-8");
						if (job.ringBuffer.length > BASH_BG_RING_MAX_BYTES) {
							job.ringBuffer = job.ringBuffer.slice(job.ringBuffer.length - BASH_BG_RING_MAX_BYTES);
							job.ringTruncated = true;
						}
					};
					child.stdout?.on("data", appendRing);
					child.stderr?.on("data", appendRing);
					// Resolve the foreground promise NOW with the handle; the detached
					// process lives on and its eventual exit is recorded below.
					settled.done = true;
					// Cancel the explicit-timeout hard-kill: once detached into a tracked
					// job, the foreground timeout intent no longer applies (the job is
					// killed on shutdown or on demand instead). Without this, a
					// `background:true` + `timeout>0` combo would let timeoutHandle fire
					// killProcessTree on the already-detached job, contradicting the
					// "keeps running detached" contract surfaced to the caller.
					if (timeoutHandle) clearTimeout(timeoutHandle);
					if (signal) signal.removeEventListener("abort", onAbort);
					resolve({ exitCode: null, promotedJobId: id });
				};

				if (backgroundImmediate) {
					// Explicit background request: detach after a brief startup window so an
					// immediate failure still surfaces in the foreground. A command that
					// finishes within the window resolves normally (close handler clears this).
					autoBgHandle = setTimeout(promoteToBackground, resolveBackgroundStartupMs());
				} else if (autoBgSeconds > 0 && (timeout === undefined || timeout <= 0)) {
					autoBgHandle = setTimeout(promoteToBackground, autoBgSeconds * 1000);
				}

				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				waitForChildProcess(child)
					.then((code) => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (autoBgHandle) clearTimeout(autoBgHandle);
						// Already promoted: the foreground promise resolved on promotion.
						// Just record the eventual exit on the job and stop tracking the pid.
						if (promoted) {
							promoted.exited = true;
							promoted.exitCode = code;
							if (child.pid) untrackDetachedChildPid(child.pid);
							return;
						}
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (signal) signal.removeEventListener("abort", onAbort);
						if (signal?.aborted) {
							reject(new Error("aborted"));
							return;
						}
						if (timedOut) {
							reject(new Error(`timeout:${timeout}`));
							return;
						}
						settled.done = true;
						resolve({ exitCode: code });
					})
					.catch((err) => {
						if (timeoutHandle) clearTimeout(timeoutHandle);
						if (autoBgHandle) clearTimeout(autoBgHandle);
						if (promoted) {
							promoted.exited = true;
							if (child.pid) untrackDetachedChildPid(child.pid);
							return;
						}
						if (child.pid) untrackDetachedChildPid(child.pid);
						if (signal) signal.removeEventListener("abort", onAbort);
						reject(err);
					});
			});
		},
	};
}

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

/** Resolve the optional per-call `cwd` arg against the session root. Absolute
 * paths are used verbatim; relative ones resolve against `baseCwd`; empty/missing
 * falls back to `baseCwd`. Existence is validated downstream by the executor,
 * which rejects with a clear "Working directory does not exist" error. */
export function resolveBashCwd(baseCwd: string, cwdArg?: string): string {
	const trimmed = cwdArg?.trim();
	if (!trimmed) return baseCwd;
	// Expand a leading `~`/`~/` to the home dir first — otherwise `~/proj` is not
	// absolute (especially on Windows) and resolves under baseCwd as a literal
	// directory named "~", which the executor then rejects as non-existent.
	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return resolvePath(homedir(), trimmed.slice(2));
	}
	return isAbsolute(trimmed) ? trimmed : resolvePath(baseCwd, trimmed);
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

const BASH_PREVIEW_LINES = 0;
const BASH_UPDATE_THROTTLE_MS = 100;
// Below this, a successful command's `Took Xs` footer is pure noise — the
// duration carries no signal, so we drop it (kept on error/truncation/slow).
const BASH_SLOW_FOOTER_MS = 2000;

// Derived text the result render consumes. Recomputed only when the source
// snapshot identity changes (see BashTextMemo) — interval/resize/invalidate
// re-renders reuse it instead of re-running stripAnsi/sanitize/split.
type BashTextDerived = {
	failure: { body: string; label: string } | undefined;
	output: string;
	logicalLines: string[];
};

// Memoized text processing for the result body. `contentRef` is the
// `result.content` array reference — stable across re-renders without a new
// tool update (tool-execution.ts forwards the same array by reference), and
// freshly allocated on each 100ms streaming update. So `===` on it (plus the
// two flags that feed the computation) is an exact "same snapshot" check.
type BashTextMemo = {
	contentRef: unknown;
	showImages: boolean;
	isError: boolean;
	derived: BashTextDerived;
};

// Consecutive 1s elapsed-interval ticks allowed without a `renderResult` before
// the interval is treated as orphaned and self-cleared. A live row re-renders
// within one frame of the interval's `invalidate()`, so this many seconds of
// silence means the row was torn down without a final render — generous enough
// to never trip a still-attached row, small enough to bound the leak.
const BASH_INTERVAL_STALE_TICKS = 5;

type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
	// Ticks the live-elapsed `interval` has fired without `renderResult` running
	// in between. A still-attached row re-renders within one frame of the
	// interval's `invalidate()`, so a few consecutive ticks with no render means
	// the row was torn down (session reset, transcript trimmed, view swapped)
	// without a final non-partial/error render ever clearing the timer. We then
	// self-clear so the interval can't fire `invalidate()` for the process
	// lifetime. Reset to 0 on every `renderResult`.
	intervalTicksSinceRender: number | undefined;
	// Count of collapsed (hidden) output lines, set by the result body and read
	// by the call/title component so the `(N earlier lines, …)` hint rides on the
	// command line instead of costing its own row. Logical-line based (not visual)
	// so it's width-independent — no cross-component render-order race.
	skippedHint: number | undefined;
	// Memo of the last text processing; reused on same-snapshot rebuilds.
	textMemo: BashTextMemo | undefined;
	// Test-only: bumped whenever the text is actually (re)processed (memo miss),
	// so tests can assert that a no-op rebuild reused the memo. Never read by prod.
	textComputeCount?: number;
};

class BashResultRenderComponent extends Container {}

/**
 * Title component for a bash call. Renders the `$ command` line and, when the
 * result body has collapsed output, appends the `(N earlier lines, …to expand)`
 * hint to that same line so it costs no extra row. The skipped count is read
 * from the shared call state at render(width) time — after the result renderer
 * set it during the same rebuild — so the hint is always current with no extra
 * render pass.
 */
class BashCallRenderComponent {
	args: { command?: string; timeout?: number } | undefined;
	expanded = false;
	callState: BashRenderState | undefined;
	private cacheKey: string | undefined;
	private cacheLines: string[] | undefined;

	render(width: number): string[] {
		const skipped = this.expanded ? 0 : (this.callState?.skippedHint ?? 0);
		const command = str(this.args?.command);
		const key = `${width} ${skipped} ${this.expanded ? 1 : 0} ${command ?? ""} ${this.args?.timeout ?? ""}`;
		if (this.cacheLines !== undefined && this.cacheKey === key) return this.cacheLines;

		// Expanded, or no/invalid command: defer to the full multi-row formatter.
		if (this.expanded || command === null || command === "") {
			let title = formatBashCall(this.args, this.expanded);
			if (skipped > 0) {
				title += ` ${theme.fg("muted", `(${skipped} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
			}
			this.cacheLines = new Text(title, 0, 0).render(width);
			this.cacheKey = key;
			return this.cacheLines;
		}

		// Collapsed: clamp the command to a single visual row (shared with the
		// user `!` bash header). Skipped output lines fold into the hint count.
		const timeout = this.args?.timeout as number | undefined;
		const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
		this.cacheLines = [
			clampBashCommandRow({
				command,
				width,
				colorKey: "toolTitle",
				extraHidden: skipped,
				suffix: timeoutSuffix,
			}),
		];
		this.cacheKey = key;
		return this.cacheLines;
	}

	invalidate(): void {
		this.cacheKey = undefined;
		this.cacheLines = undefined;
	}
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Trailing failure status appended by `appendStatus` in `execute`. Lifted out
 * of the displayed output so the TUI can fold it into the muted footer line
 * instead of paying for a separate paragraph. The LLM-facing text is left
 * untouched — the caller still sees the verbatim status in its tool result.
 */
function extractFailureSuffix(text: string): { body: string; label: string } | undefined {
	const patterns: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
		[/^([\s\S]*?)(?:\n\n)?Command exited with code (-?\d+)$/, (m) => `exit ${m[2]}`],
		[/^([\s\S]*?)(?:\n\n)?Command aborted$/, () => "aborted"],
		[/^([\s\S]*?)(?:\n\n)?Command timed out after ([\d.]+) seconds$/, (m) => `timed out ${m[2]}s`],
	];
	for (const [re, label] of patterns) {
		const match = text.match(re);
		if (match) {
			return { body: match[1].trimEnd(), label: label(match) };
		}
	}
	return undefined;
}

const BASH_TITLE_HEAD_LINES = 3;

function formatBashCall(args: { command?: string; timeout?: number } | undefined, expanded: boolean): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";

	if (command === null) {
		return theme.fg("toolTitle", theme.bold(`$ ${invalidArgText(theme)}`)) + timeoutSuffix;
	}
	if (!command) {
		return theme.fg("toolTitle", theme.bold(`$ ${theme.fg("toolOutput", "...")}`)) + timeoutSuffix;
	}

	// Multiline heredocs and inline scripts otherwise dominate the title block;
	// keep the first few lines and defer the rest to the expand affordance.
	if (!expanded && command.includes("\n")) {
		const lines = command.split("\n");
		if (lines.length > BASH_TITLE_HEAD_LINES) {
			const head = lines.slice(0, BASH_TITLE_HEAD_LINES).join("\n");
			const remaining = lines.length - BASH_TITLE_HEAD_LINES;
			const titlePart = theme.fg("toolTitle", theme.bold(`$ ${head}`));
			const hint = `\n${theme.fg("muted", `... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")})`;
			return titlePart + hint + timeoutSuffix;
		}
	}

	return theme.fg("toolTitle", theme.bold(`$ ${command}`)) + timeoutSuffix;
}

// Process the result text (stripAnsi/sanitize/failure-peel/split) once per
// distinct snapshot and cache it on the shared state. A streaming bash emits a
// partial update every 100ms with a fresh content array, but the 1s elapsed
// interval, TUI resizes, and invalidates re-run this render with the SAME
// array — those reuse the memo and skip the per-rebuild string work. Only the
// content identity + the two flags that affect the computation are compared
// (expanded changes presentation, not text, so it's excluded by design).
function computeBashTextDerived(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> },
	showImages: boolean,
	isError: boolean,
	callState: BashRenderState,
): BashTextDerived {
	const memo = callState.textMemo;
	if (memo && memo.contentRef === result.content && memo.showImages === showImages && memo.isError === isError) {
		return memo.derived;
	}

	const rawOutput = getTextOutput(result, showImages).trim();
	// Peel the trailing `Command (exited|aborted|timed out…)` line off so it
	// becomes a chip on the muted footer instead of a standalone paragraph.
	const failure = isError ? extractFailureSuffix(rawOutput) : undefined;
	const output = failure ? failure.body : rawOutput;
	const derived: BashTextDerived = { failure, output, logicalLines: output.split("\n") };
	callState.textMemo = { contentRef: result.content, showImages, isError, derived };
	callState.textComputeCount = (callState.textComputeCount ?? 0) + 1;
	return derived;
}

function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
	isError: boolean,
	callState: BashRenderState,
): void {
	component.clear();

	const { failure, output, logicalLines } = computeBashTextDerived(result, showImages, isError, callState);
	const emptyOutput = output.length === 0 || output === "(no output)";

	// Default: nothing hidden. The collapsed branch below overrides this; the
	// title component reads it to decide whether to show the inline hint.
	callState.skippedHint = 0;

	// Tracks whether any body/warning line is actually rendered above the footer.
	// With BASH_PREVIEW_LINES === 0 the body is fully collapsed (just the inline
	// hint on the command line), so the footer/warning must hug the header instead
	// of leaving an orphan blank line.
	let hasContentAbove = false;
	if (!emptyOutput) {
		if (options.expanded) {
			const styledOutput = logicalLines.map((line) => theme.fg("toolOutput", line)).join("\n");
			component.addChild(new Text(styledOutput, 0, 0));
			hasContentAbove = true;
		} else {
			// Show only the last N logical lines, each clipped to one visual row,
			// so the body footprint is a fixed N rows. The count of hidden lines
			// is handed to the title component to render on the command line.
			// `slice(-0)` returns the whole array, so guard the "command-only" case
			// (BASH_PREVIEW_LINES === 0) explicitly.
			const previewLines = BASH_PREVIEW_LINES > 0 ? logicalLines.slice(-BASH_PREVIEW_LINES) : [];
			callState.skippedHint = logicalLines.length - previewLines.length;
			hasContentAbove = previewLines.length > 0;
			component.addChild({
				render: (width: number) =>
					previewLines.map((line) => theme.fg("toolOutput", truncateToWidth(line, width, "…"))),
				invalidate: () => {},
			});
		}
	}

	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	const hasWarnings = !!truncation?.truncated || !!fullOutputPath;
	if (hasWarnings) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? BASH_MAX_BYTES)} limit)`,
				);
			}
		}
		const warningPrefix = hasContentAbove ? "\n" : "";
		component.addChild(new Text(`${warningPrefix}${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
		hasContentAbove = true;
	}

	// Footer fold: `(no output) · exit 2 · 0.1s`-style single muted line. It hugs
	// whatever is directly above — the command header when the body is fully
	// collapsed (no preview lines / no warning), or the last rendered line
	// otherwise — so no orphan blank line sits between the command and the footer.
	const footerParts: string[] = [];
	const testSummary = result.details?.testSummary;
	if (testSummary) {
		footerParts.push(testSummary);
	}
	if (emptyOutput && (failure || isError)) {
		footerParts.push("(no output)");
	}
	if (failure) {
		footerParts.push(failure.label);
	}
	if (startedAt !== undefined) {
		const endTime = endedAt ?? Date.now();
		const elapsed = endTime - startedAt;
		// Surface duration only when it carries signal: live (streaming),
		// errored, truncated, or genuinely slow. A fast successful command's
		// `Took 0.1s` is noise, so it's dropped to save the footer line.
		const showDuration = options.isPartial || isError || hasWarnings || elapsed >= BASH_SLOW_FOOTER_MS;
		if (showDuration) {
			const label = options.isPartial ? "Elapsed" : "Took";
			footerParts.push(`${label} ${formatDuration(elapsed)}`);
		}
	}
	if (footerParts.length === 0) {
		return;
	}
	const prefix = hasContentAbove ? "\n" : "";
	component.addChild(new Text(`${prefix}${theme.fg("muted", footerParts.join(" · "))}`, 0, 0));
}

/**
 * When a bash command produced large JSON/NDJSON that was truncated (crush is on
 * by default; PIT_NO_JSON_CRUSH opts out), replace the blind head/tail line-cut with a structural crush
 * (schema + head/tail samples + omitted counts). Reads the full output back from
 * the temp file the accumulator already persisted on truncation, so nothing is
 * lost — the file stays the source of truth for any elided detail. Returns
 * undefined (caller keeps the normal formatted output) when not enabled, not
 * truncated, the temp file is unavailable, or the output is not JSON.
 */
async function crushBashJsonOutput(snapshot: OutputSnapshot): Promise<string | undefined> {
	if (!isJsonCrushEnabled()) return undefined;
	if (!snapshot.truncation.truncated || !snapshot.fullOutputPath) return undefined;
	let full: string;
	try {
		full = await readFile(snapshot.fullOutputPath, "utf-8");
	} catch {
		return undefined;
	}
	return maybeCrushJsonOutput({
		text: full,
		shouldAttempt: true,
		originalSize: formatSize(snapshot.truncation.totalBytes),
		recoveryHint: `Full output: ${snapshot.fullOutputPath} — read it or use \`bash jq\` for any elided detail.`,
	});
}

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const ops = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	return {
		name: "bash",
		label: "bash",
		activity: (args) => classifyBashCommand(args.command),
		description: `Execute a bash command in the current working directory. Use bash only for what no dedicated tool covers: build/test/install scripts, git, network requests, process management, shell pipelines/redirects. Prefer read/grep/find/ls/write/edit for file operations.

Returns stdout and stderr, truncated to the last ${BASH_MAX_LINES} lines or ${BASH_MAX_BYTES / 1024}KB (whichever is hit first); full output is saved to a temp file when truncated. Pass one "command" string (join steps with " && "); each call runs in a fresh shell with no carried state. To run somewhere other than the session root, set the "cwd" parameter instead of prefixing "cd /path &&" — it keeps the command line clean. Optional timeout in seconds.`,
		promptSnippet: "Execute bash commands (build/test/git/network only; prefer read/grep/find/ls for files)",
		parameters: bashSchema,
		prepareArguments: prepareBashArguments,
		async execute(
			_toolCallId,
			{
				command,
				timeout,
				cwd: cwdArg,
				background,
			}: { command: string; timeout?: number; cwd?: string; background?: boolean },
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(resolvedCommand, resolveBashCwd(cwd, cwdArg), spawnHook);
			const output = new OutputAccumulator({
				tempFilePrefix: "pi-bash",
				maxLines: BASH_MAX_LINES,
				maxBytes: BASH_MAX_BYTES,
				headLines: BASH_HEAD_MAX_LINES,
				headBytes: BASH_HEAD_MAX_BYTES,
			});
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				// Collapse runs of identical consecutive lines (repeated log/test/warning
				// lines) to cut LLM tokens at the source. Lossless of meaning; the full
				// output is preserved on disk when truncated (fullOutputPath below).
				let text = snapshot.content ? collapseRepeatedLines(snapshot.content) : emptyText;
				let details: BashToolDetails | undefined;
				// Compile a test-runner headline ("✓ 142 passed") so the activity row shows a
				// compact result chip instead of leaving the full dump as the only signal.
				const testSummary = snapshot.content ? summarizeTestRun(snapshot.content)?.headline : undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (snapshot.composed) {
						const { headLines, tailLines, elidedLines } = snapshot.composed;
						text += `\n\n[Showing first ${headLines} + last ${tailLines} of ${truncation.totalLines} lines (${elidedLines} elided). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(BASH_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				if (testSummary) details = { ...details, testSummary };
				return { text, details };
			};

			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;

			try {
				let exitCode: number | null;
				let promotedJobId: string | undefined;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout: normalizeBashTimeout(timeout),
						env: spawnContext.env,
						label: command,
						// The agent tool consumes `promotedJobId` (surfaces the handle in the
						// returned message), so it opts IN to auto-backgrounding. The user `!`
						// path (bash-executor) does not read it and therefore leaves it OFF.
						autoBackground: true,
						// Explicit `background: true` detaches right after startup instead of
						// waiting out the auto-background threshold.
						backgroundImmediate: background === true,
					});
					exitCode = result.exitCode;
					promotedJobId = result.promotedJobId;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const { text: formattedText, details } = formatOutput(snapshot);
				const outputText = (await crushBashJsonOutput(snapshot)) ?? formattedText;
				// Promoted to background: the command did NOT finish — it crossed the
				// auto-background threshold and was detached into a tracked job. Surface
				// the handle + the output captured up to promotion, without throwing.
				if (promotedJobId) {
					// Report the REAL wall-clock time the command ran before promotion
					// (promotedAt − startedAt on the job), not the configured threshold —
					// the env can change between exec and here, and event-loop drift means
					// the timer fires at/after the threshold, never exactly on it. Fall
					// back to the threshold only if the job record is somehow gone.
					const job = getBashBackgroundJob(promotedJobId);
					const elapsedSeconds =
						job !== undefined ? (job.promotedAt - job.startedAt) / 1000 : resolveAutoBackgroundSeconds();
					const status = `Command promoted to background id=${promotedJobId} after ${elapsedSeconds.toFixed(1)}s (still running). Output shown is up to promotion; the process keeps running detached and is killed on shutdown. Its later output and exit code are buffered under this id and can be recovered, and the job can be killed on demand by referencing id=${promotedJobId}.`;
					return { content: [{ type: "text", text: appendStatus(outputText, status) }], details };
				}
				if (exitCode !== 0 && exitCode !== null) {
					throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
				}
				return { content: [{ type: "text", text: outputText }], details };
			} finally {
				clearUpdateTimer();
			}
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const comp =
				context.lastComponent instanceof BashCallRenderComponent
					? context.lastComponent
					: new BashCallRenderComponent();
			comp.args = args;
			comp.expanded = context.expanded;
			comp.callState = state;
			comp.invalidate();
			return comp;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			// This render proves the row is still live (an interval-driven
			// invalidate, a streaming update, or a resize all land here), so reset
			// the no-render tick counter the interval uses to detect teardown.
			state.intervalTicksSinceRender = 0;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				// Refresh the elapsed-time footer once per second while the command
				// streams. If the row is torn down without a final non-partial/error
				// render (session reset, transcript trim, view swap), nothing here
				// would ever clear this timer — it would fire invalidate() forever.
				// Guard it: each tick increments a counter that renderResult resets;
				// a live row re-renders within one frame, so several consecutive
				// ticks with no render means the row is gone — self-clear then.
				state.interval = setInterval(() => {
					state.intervalTicksSinceRender = (state.intervalTicksSinceRender ?? 0) + 1;
					if ((state.intervalTicksSinceRender ?? 0) > BASH_INTERVAL_STALE_TICKS) {
						if (state.interval) {
							clearInterval(state.interval);
							state.interval = undefined;
						}
						return;
					}
					context.invalidate();
				}, 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
				context.isError,
				state,
			);
			component.invalidate();
			return component;
		},
	};
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}
