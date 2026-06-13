/**
 * Shared command execution utilities for extensions and custom tools.
 */

import { spawn } from "node:child_process";
import { recordDiagnostic } from "@pit/ai";
import { waitForChildProcess } from "../utils/child-process.ts";
import { killProcessTree } from "../utils/shell.ts";
import { OutputAccumulator } from "./tools/output-accumulator.ts";
import { BASH_HEAD_MAX_BYTES, BASH_HEAD_MAX_LINES, BASH_MAX_BYTES, BASH_MAX_LINES } from "./tools/truncate.ts";

/** Delay before escalating SIGTERM to SIGKILL when a kill is requested. */
const SIGKILL_GRACE_MS = 5000;

/**
 * Options for executing shell commands.
 */
export interface ExecOptions {
	/** AbortSignal to cancel the command */
	signal?: AbortSignal;
	/** Timeout in milliseconds */
	timeout?: number;
	/** Working directory */
	cwd?: string;
}

/**
 * Result of executing a shell command.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	/**
	 * Set when stdout or stderr exceeded the in-memory cap and was reduced to a
	 * head + elided-middle + tail excerpt. The unbounded accumulation that this
	 * guards against would otherwise grow the heap until the process OOMs.
	 */
	truncated?: boolean;
}

/**
 * Execute a shell command and return stdout/stderr/code.
 * Supports timeout and abort signal.
 *
 * stdout/stderr are bounded by a rolling head+tail accumulator (same budget as
 * the bash tool) so a verbose command cannot exhaust the heap; normal small,
 * fast-finishing output is returned byte-identically. The SIGKILL escalation
 * timer is always cleared on settle so it never pins the event loop.
 */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const proc = spawn(command, args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Bounded accumulators: head + tail retained, middle elided once the cap is
		// hit. Mirrors the bash tool budget so extension output is capped coherently.
		const accumulatorOptions = {
			maxLines: BASH_MAX_LINES,
			maxBytes: BASH_MAX_BYTES,
			headLines: BASH_HEAD_MAX_LINES,
			headBytes: BASH_HEAD_MAX_BYTES,
		};
		const stdoutAcc = new OutputAccumulator(accumulatorOptions);
		const stderrAcc = new OutputAccumulator(accumulatorOptions);
		let killed = false;
		let timeoutId: NodeJS.Timeout | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let settled = false;

		const clearTimers = () => {
			if (timeoutId) {
				clearTimeout(timeoutId);
				timeoutId = undefined;
			}
			// The SIGKILL escalation timer must be cleared on every settle path; left
			// pending it keeps the event loop alive after the process already exited.
			if (killTimer) {
				clearTimeout(killTimer);
				killTimer = undefined;
			}
		};

		const killProcess = () => {
			if (killed) return;
			killed = true;
			recordDiagnostic({
				category: "process.kill",
				level: "warn",
				source: "exec.execCommand",
				context: { pid: proc.pid },
			});
			proc.kill("SIGTERM");
			// Force kill the whole tree after a grace period if SIGTERM is ignored.
			killTimer = setTimeout(() => {
				killTimer = undefined;
				if (!proc.killed && proc.pid !== undefined) {
					killProcessTree(proc.pid);
				}
			}, SIGKILL_GRACE_MS);
		};

		const removeAbortListener = () => {
			if (options?.signal) {
				options.signal.removeEventListener("abort", killProcess);
			}
		};

		const settle = (code: number) => {
			if (settled) return;
			settled = true;
			clearTimers();
			removeAbortListener();
			stdoutAcc.finish();
			stderrAcc.finish();
			const stdoutSnap = stdoutAcc.snapshot();
			const stderrSnap = stderrAcc.snapshot();
			const truncated = stdoutSnap.truncation.truncated || stderrSnap.truncation.truncated;
			if (truncated) {
				recordDiagnostic({
					category: "output.cap",
					level: "warn",
					source: "exec.execCommand",
					context: { note: "stdout/stderr truncated" },
				});
			}
			resolve({
				stdout: stdoutSnap.content,
				stderr: stderrSnap.content,
				code,
				killed,
				truncated,
			});
		};

		// Handle abort signal
		if (options?.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
			}
		}

		// Handle timeout
		if (options?.timeout && options.timeout > 0) {
			timeoutId = setTimeout(() => {
				killProcess();
			}, options.timeout);
		}

		proc.stdout?.on("data", (data: Buffer) => {
			stdoutAcc.append(data);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderrAcc.append(data);
		});

		// Wait for process termination without hanging on inherited stdio handles
		// held open by detached descendants.
		waitForChildProcess(proc)
			.then((code) => settle(code ?? 0))
			.catch((_err) => settle(1));
	});
}
