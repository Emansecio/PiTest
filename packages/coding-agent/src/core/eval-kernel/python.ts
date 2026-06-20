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
import { recordDiagnostic } from "@pit/ai";
import { killProcessTree } from "../../utils/shell.ts";
import type { EvalKernel, EvalRequest, EvalResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

// Ceiling on accumulated stdout+stderr per call. A runaway loop (`while True:
// print('x')`) would otherwise grow the buffer to GBs before the timeout fires
// and OOM the host. Generous vs bash's 24KB cap — eval legitimately produces
// larger dumps — but bounded. Overridable for tests via PIT_EVAL_MAX_OUTPUT_BYTES.
const DEFAULT_MAX_EVAL_OUTPUT_BYTES = 8 * 1024 * 1024; // 8MB

function resolveMaxEvalOutputBytes(): number {
	const raw = process.env.PIT_EVAL_MAX_OUTPUT_BYTES;
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_EVAL_OUTPUT_BYTES;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_EVAL_OUTPUT_BYTES;
	return parsed;
}

const PRELUDE = "import sys, os, json, traceback as __pi_traceback\n";

interface PendingCall {
	resolve(result: EvalResult): void;
	reject(err: Error): void;
	sentinel: string;
	startedAt: number;
	stdoutBuf: string;
	stderrBuf: string;
	// Index to resume the sentinel scan from, so each chunk doesn't re-scan the
	// whole buffer (O(n²)). Kept (sentinel.length - 1) behind the buffer end so a
	// sentinel split across two chunks is still matched.
	stdoutSearch: number;
	stderrSearch: number;
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
	private maxOutputBytes = resolveMaxEvalOutputBytes();

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
					if (this.proc !== child) return; // a respawn superseded this child
					this.spawnError = err as Error;
					this.alive = false;
					this.failPending(err as Error);
				});
				child.on("exit", () => {
					if (this.proc !== child) return; // stale child from before a respawn
					this.alive = false;
					this.failPending(new Error("python kernel exited"));
				});
				child.stdout.setEncoding("utf8");
				child.stderr.setEncoding("utf8");
				child.stdout.on("data", (chunk: string) => {
					if (this.proc !== child) return;
					this.onStdout(chunk);
				});
				child.stderr.on("data", (chunk: string) => {
					if (this.proc !== child) return;
					this.onStderr(chunk);
				});
				// A write racing the interpreter's death (timeout/abort proc.kill, exit)
				// hits a closed stdin → EPIPE as an async 'error' event. Without a listener
				// Node makes it fatal (uncaughtException → process death). Swallow it; the
				// exit handler above already fails the pending calls.
				child.stdin.on("error", () => {});
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
		const c = this.current;
		if (!c) return;
		c.stdoutBuf += chunk;
		if (this.enforceOutputCap(c)) return;
		const idx = c.stdoutBuf.indexOf(c.sentinel, c.stdoutSearch);
		if (idx >= 0) {
			c.stdoutBuf = c.stdoutBuf.slice(0, idx);
			c.stdoutDone = true;
			this.maybeResolve();
			return;
		}
		// Resume next scan just before the new tail so a split sentinel still matches.
		c.stdoutSearch = Math.max(0, c.stdoutBuf.length - c.sentinel.length + 1);
	}

	private onStderr(chunk: string): void {
		const c = this.current;
		if (!c) return;
		c.stderrBuf += chunk;
		if (this.enforceOutputCap(c)) return;
		const idx = c.stderrBuf.indexOf(c.sentinel, c.stderrSearch);
		if (idx >= 0) {
			c.stderrBuf = c.stderrBuf.slice(0, idx);
			c.stderrDone = true;
			this.maybeResolve();
			return;
		}
		c.stderrSearch = Math.max(0, c.stderrBuf.length - c.sentinel.length + 1);
	}

	// Length of a buffer counting only the payload BEFORE the sentinel. Once the
	// sentinel has landed the call is finished, so its trailing bytes (sentinel +
	// any post-sentinel noise) must not count toward the runaway cap. When the
	// sentinel is split across chunks, the partial sentinel prefix is sitting at the
	// tail of the buffer not yet matchable by indexOf — discount the longest such
	// trailing prefix so an in-flight sentinel can't push a completed call over the
	// cap. The discount is bounded by sentinel.length, so a genuine runaway (which
	// never emits the sentinel) trips at most ~46 bytes later — negligible.
	private payloadLength(buf: string, sentinel: string): number {
		const idx = buf.indexOf(sentinel);
		if (idx >= 0) return idx;
		// Longest suffix of buf that is a prefix of sentinel (a possible split sentinel).
		const maxK = Math.min(sentinel.length - 1, buf.length);
		for (let k = maxK; k > 0; k--) {
			if (buf.endsWith(sentinel.slice(0, k))) return buf.length - k;
		}
		return buf.length;
	}

	// Kill the runaway process when combined output exceeds the cap. Returns true
	// when it tripped (caller must stop touching the now-cleared pending call).
	private enforceOutputCap(c: PendingCall): boolean {
		// Measure only the pre-sentinel payload. The sentinel (~46 bytes) is appended
		// to these same buffers when the call COMPLETES; if legitimate output lands
		// right at the cap boundary, the chunk carrying the sentinel could push the
		// raw length over the limit and kill a call that actually finished, wiping the
		// whole kernel. Scanning to the sentinel first keeps the cap honest: a true
		// runaway never reaches the finally that emits the sentinel, so it still trips.
		const effective = this.payloadLength(c.stdoutBuf, c.sentinel) + this.payloadLength(c.stderrBuf, c.sentinel);
		if (effective <= this.maxOutputBytes) return false;
		const proc = this.proc;
		recordDiagnostic({
			category: "output.cap",
			level: "error",
			source: "eval-kernel.python",
			context: { bytes: effective, pid: proc?.pid },
		});
		// killProcessTree tears down any children the user code spawned too.
		if (proc?.pid) killProcessTree(proc.pid);
		try {
			proc?.kill();
		} catch {
			// ignore
		}
		this.alive = false;
		if (this.current === c) {
			if (c.timer) clearTimeout(c.timer);
			this.current = undefined;
			c.reject(new Error(`eval output exceeded ${this.maxOutputBytes} bytes (killed)`));
		}
		return true;
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
			stdoutSearch: 0,
			stderrSearch: 0,
			stdoutDone: false,
			stderrDone: false,
			timer: undefined,
		};
		this.current = pending;

		pending.timer = setTimeout(() => {
			// Kill the kernel — the interpreter state is unrecoverable mid-exec.
			// killProcessTree tears down any children the user code spawned too. Do
			// not also call proc.kill() here: on Windows it terminates the parent
			// synchronously before the async taskkill /T can enumerate the tree,
			// orphaning the children. killProcessTree already targets the parent pid.
			if (proc.pid) killProcessTree(proc.pid);
			else {
				try {
					proc.kill();
				} catch {
					// ignore
				}
			}
			this.alive = false;
			if (this.current === pending) {
				this.current = undefined;
				reject(new Error(`eval timed out after ${timeoutMs}ms`));
			}
		}, timeoutMs);

		if (signal) {
			const onAbort = () => {
				// killProcessTree tears down any children the user code spawned too;
				// avoid proc.kill() so we don't pre-empt taskkill /T (see timeout path).
				if (proc.pid) killProcessTree(proc.pid);
				else {
					try {
						proc.kill();
					} catch {
						// ignore
					}
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
			// killProcessTree tears down any children the user code spawned too;
			// avoid proc.kill() so we don't pre-empt taskkill /T (see timeout path).
			if (this.proc.pid) killProcessTree(this.proc.pid);
			else {
				try {
					this.proc.kill();
				} catch {
					// ignore
				}
			}
			this.proc = undefined;
		}
		this.failPending(new Error("kernel closed"));
	}
}

export function createPyKernel(cwd: string): EvalKernel {
	return new PythonKernel(cwd);
}
