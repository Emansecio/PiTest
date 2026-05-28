/**
 * Persistent Python eval kernel.
 *
 * Spawns `python3` (falls back to `python`) with `-i -u` so the interpreter
 * stays alive between calls and stdout is unbuffered. Each `exec` sends a
 * wrapped block of user code plus a unique sentinel that marks the end of
 * both stdout and stderr for that call. We read both streams until the
 * sentinel appears; bytes before the sentinel are the user's output.
 *
 * State (vars, imports, defined functions) persists across calls because we
 * never tear down the interpreter — we just keep feeding it more code.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EvalKernel, EvalRequest, EvalResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

const PRELUDE = "import sys, os, json, traceback as __pi_traceback\n";

interface PendingCall {
	resolve(result: EvalResult): void;
	reject(err: Error): void;
	sentinel: string;
	startedAt: number;
	stdoutBuf: string;
	stderrBuf: string;
	stdoutDone: boolean;
	stderrDone: boolean;
	timer: NodeJS.Timeout | undefined;
}

class PythonKernel implements EvalKernel {
	private proc: ChildProcessWithoutNullStreams | undefined;
	private alive = false;
	private spawnError: Error | undefined;
	private current: PendingCall | undefined;
	private queue: Array<() => void> = [];
	private cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
		this.spawn();
	}

	private spawn(): void {
		const candidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
		let lastErr: Error | undefined;
		for (const cmd of candidates) {
			try {
				const child = spawn(cmd, ["-i", "-u"], {
					cwd: this.cwd,
					stdio: ["pipe", "pipe", "pipe"],
					env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
				});
				child.on("error", (err) => {
					this.spawnError = err as Error;
					this.alive = false;
					this.failPending(err as Error);
				});
				child.on("exit", () => {
					this.alive = false;
					this.failPending(new Error("python kernel exited"));
				});
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
				child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
				this.proc = child;
				this.alive = true;
				// Seed the prelude so common modules are pre-imported. Use a no-op exec
				// (no sentinel) — output is irrelevant; subsequent calls flush past it.
				child.stdin.write(PRELUDE);
				return;
			} catch (err) {
				lastErr = err as Error;
			}
		}
		this.spawnError = lastErr ?? new Error("python interpreter not found");
		this.alive = false;
	}

	private failPending(err: Error): void {
		if (this.current) {
			if (this.current.timer) clearTimeout(this.current.timer);
			this.current.reject(err);
			this.current = undefined;
		}
		const pending = this.queue.splice(0);
		for (const fn of pending) fn();
	}

	private onStdout(chunk: string): void {
		if (!this.current) return;
		this.current.stdoutBuf += chunk;
		const idx = this.current.stdoutBuf.indexOf(this.current.sentinel);
		if (idx >= 0) {
			this.current.stdoutBuf = this.current.stdoutBuf.slice(0, idx);
			this.current.stdoutDone = true;
			this.maybeResolve();
		}
	}

	private onStderr(chunk: string): void {
		if (!this.current) return;
		this.current.stderrBuf += chunk;
		const idx = this.current.stderrBuf.indexOf(this.current.sentinel);
		if (idx >= 0) {
			this.current.stderrBuf = this.current.stderrBuf.slice(0, idx);
			this.current.stderrDone = true;
			this.maybeResolve();
		}
	}

	private maybeResolve(): void {
		const c = this.current;
		if (!c || !c.stdoutDone || !c.stderrDone) return;
		if (c.timer) clearTimeout(c.timer);
		const durationMs = Date.now() - c.startedAt;
		// Strip Python's startup banner + interactive prompts from stderr so
		// the model sees only its own program's output. The banner appears
		// once on the first call; >>> prompts are emitted by the REPL between
		// statements regardless.
		const stderr = c.stderrBuf
			.replace(/^Python \d+\.\d+\.\d+[^\n]*\n[^\n]*\n/, "")
			.replace(/>>> /g, "")
			.replace(/\.\.\. /g, "")
			.replace(/\r\n/g, "\n");
		const hasError = /Traceback \(most recent call last\):/.test(stderr);
		const result: EvalResult = {
			stdout: c.stdoutBuf.replace(/\r\n/g, "\n"),
			stderr,
			durationMs,
		};
		if (hasError) {
			result.error = stderr.trim();
		}
		c.resolve(result);
		this.current = undefined;
		const next = this.queue.shift();
		if (next) next();
	}

	isAlive(): boolean {
		return this.alive;
	}

	async exec(req: EvalRequest, signal?: AbortSignal): Promise<EvalResult> {
		if (!this.alive) {
			// Try one respawn (e.g. after a previous timeout killed the proc).
			this.spawn();
			if (!this.alive) {
				throw this.spawnError ?? new Error("python kernel not alive");
			}
		}
		return new Promise<EvalResult>((resolve, reject) => {
			const run = () => this.runOne(req, signal, resolve, reject);
			if (this.current) {
				this.queue.push(run);
			} else {
				run();
			}
		});
	}

	private runOne(
		req: EvalRequest,
		signal: AbortSignal | undefined,
		resolve: (r: EvalResult) => void,
		reject: (e: Error) => void,
	): void {
		const proc = this.proc;
		if (!proc || !this.alive) {
			reject(new Error("python kernel not alive"));
			return;
		}
		const sentinel = `__EVAL_DONE_${randomUUID().replace(/-/g, "")}__`;
		const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const pending: PendingCall = {
			resolve,
			reject,
			sentinel,
			startedAt: Date.now(),
			stdoutBuf: "",
			stderrBuf: "",
			stdoutDone: false,
			stderrDone: false,
			timer: undefined,
		};
		this.current = pending;

		pending.timer = setTimeout(() => {
			// Kill the kernel — the interpreter state is unrecoverable mid-exec.
			try {
				proc.kill();
			} catch {
				// ignore
			}
			this.alive = false;
			if (this.current === pending) {
				this.current = undefined;
				reject(new Error(`eval timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);

		if (signal) {
			const onAbort = () => {
				try {
					proc.kill();
				} catch {
					// ignore
				}
				this.alive = false;
				if (this.current === pending) {
					if (pending.timer) clearTimeout(pending.timer);
					this.current = undefined;
					reject(new Error("aborted"));
				}
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}

		// The interactive interpreter parses top-level blocks by blank lines.
		// To avoid that ambiguity AND to avoid quoting nightmares, we send a
		// single logical line that base64-decodes the user code + sentinel and
		// runs the code through exec(), then prints sentinels on stdout AND
		// stderr so the reader knows the call is done. Any exception is
		// captured and rendered as a traceback to stderr.
		const codeB64 = Buffer.from(req.code, "utf8").toString("base64");
		const sentinelB64 = Buffer.from(sentinel, "utf8").toString("base64");
		// Build the wrapped Python program, then base64 it too so the only
		// quotes in the line we send to the REPL are around the base64 strings.
		const wrappedPy =
			"import base64 as __pi_b64, sys as __pi_sys, traceback as __pi_tb\n" +
			`__pi_code = __pi_b64.b64decode("${codeB64}").decode("utf-8")\n` +
			`__pi_sent = __pi_b64.b64decode("${sentinelB64}").decode("utf-8")\n` +
			"try:\n" +
			"  exec(compile(__pi_code, '<eval>', 'exec'), globals())\n" +
			"except BaseException:\n" +
			"  __pi_sys.stderr.write(__pi_tb.format_exc())\n" +
			"  __pi_sys.stderr.flush()\n" +
			"finally:\n" +
			"  print(__pi_sent, flush=True)\n" +
			"  __pi_sys.stderr.write(__pi_sent + '\\n')\n" +
			"  __pi_sys.stderr.flush()\n";
		const wrappedB64 = Buffer.from(wrappedPy, "utf8").toString("base64");
		// Single physical line: exec(base64-decoded program). The REPL sees one
		// statement, executes it immediately, no blank-line ambiguity.
		const line = `exec(__import__("base64").b64decode("${wrappedB64}").decode("utf-8"))\n`;
		proc.stdin.write(line);
	}

	async close(): Promise<void> {
		this.alive = false;
		if (this.proc) {
			try {
				this.proc.kill();
			} catch {
				// ignore
			}
			this.proc = undefined;
		}
		this.failPending(new Error("kernel closed"));
	}
}

export function createPyKernel(cwd: string): EvalKernel {
	return new PythonKernel(cwd);
}
