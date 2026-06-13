/**
 * Persistent JavaScript eval kernel.
 *
 * Spawns a long-running `node` child whose stdin receives JSON-RPC-ish
 * messages `{ id, code }` line-by-line. The driver uses `node:vm` to run
 * each piece of code inside a persistent VM context, so variables /
 * function definitions / imports declared by one call are visible to the
 * next. Per-call `console.log/error` output is captured into the reply.
 * Top-level await is supported via an async wrapper.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { recordDiagnostic } from "@pit/ai";
import { killProcessTree } from "../../utils/shell.ts";
import type { EvalKernel, EvalRequest, EvalResult } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 30_000;

// Ceiling on captured output per call (parent + child both enforce it). A
// synchronous runaway loop can flood console output before the timeout fires.
// Overridable for tests via PIT_EVAL_MAX_OUTPUT_BYTES.
const DEFAULT_MAX_EVAL_OUTPUT_BYTES = 8 * 1024 * 1024; // 8MB

function resolveMaxEvalOutputBytes(): number {
	const raw = process.env.PIT_EVAL_MAX_OUTPUT_BYTES;
	if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_EVAL_OUTPUT_BYTES;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_MAX_EVAL_OUTPUT_BYTES;
	return parsed;
}

// The parent kill-timer gets a small grace over the driver's vm timeout so a
// synchronous runaway loop is aborted in-VM first (clean error reply, kernel
// state survives) instead of racing the parent's proc.kill(). The parent timer
// remains the backstop for async hangs that vm's timeout cannot interrupt.
const DRIVER_TIMEOUT_GRACE_MS = 500;

const DRIVER_SOURCE = `
const vm = require("node:vm");
const ctx = vm.createContext({
	console,
	require,
	process,
	Buffer,
	setTimeout,
	clearTimeout,
	setInterval,
	clearInterval,
	setImmediate,
	clearImmediate,
	queueMicrotask,
	URL,
	URLSearchParams,
	TextEncoder,
	TextDecoder,
	fetch: globalThis.fetch,
});
// Shared globals: anything assigned to globalThis inside the context is
// visible to subsequent calls.
ctx.globalThis = ctx;

function capture(maxBytes) {
	const out = [];
	const err = [];
	// Track accumulated chars so a runaway console.log loop can't grow the arrays
	// without bound (the parent would still OOM buffering the reply). Once over
	// the cap we push one '[output truncated]' marker and drop the rest.
	const state = { bytes: 0, truncated: false };
	const origLog = console.log;
	const origErr = console.error;
	const origWarn = console.warn;
	const origInfo = console.info;
	const fmt = (args) => args.map((a) => {
		if (typeof a === "string") return a;
		try { return JSON.stringify(a); } catch { return String(a); }
	}).join(" ");
	const sink = (arr, line) => {
		if (state.truncated) return;
		if (state.bytes >= maxBytes) {
			state.truncated = true;
			arr.push("[output truncated]");
			return;
		}
		state.bytes += line.length;
		arr.push(line);
	};
	console.log = (...args) => { sink(out, fmt(args)); };
	console.info = (...args) => { sink(out, fmt(args)); };
	console.warn = (...args) => { sink(err, fmt(args)); };
	console.error = (...args) => { sink(err, fmt(args)); };
	const restore = () => {
		console.log = origLog;
		console.error = origErr;
		console.warn = origWarn;
		console.info = origInfo;
	};
	return { out, err, restore };
}

function hoistTopLevelBindings(src) {
	// Rewrite top-level \`const x = ...\` and \`let x = ...\` into \`var x = ...\`
	// so declarations persist across scripts in the shared context. We only
	// touch lines whose first non-whitespace token is the keyword, so nested
	// declarations inside functions/blocks are left alone. This is a heuristic
	// — strings/comments containing the keyword at column 0 would be misread,
	// which is acceptable for an eval REPL.
	const lines = src.split(/\\r?\\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const m = line.match(/^(\\s*)(const|let)\\s+/);
		if (m && m[1].length === 0) {
			lines[i] = "var " + line.slice(m[0].length);
		}
	}
	return lines.join("\\n");
}

function needsAsyncWrap(src) {
	// Cheap heuristic: any \`await\` token not inside an obvious function. Wrap
	// in an async IIFE only when needed so top-level \`var\` declarations stay
	// at the script's top level (and therefore on the context).
	return /\\bawait\\b/.test(src);
}

async function runOne(code, timeoutMs, maxBytes) {
	const cap = capture(maxBytes);
	let error;
	try {
		const hoisted = hoistTopLevelBindings(code);
		const wrapped = needsAsyncWrap(hoisted)
			? "(async () => {\\n" + hoisted + "\\n})()"
			: hoisted;
		const script = new vm.Script(wrapped, { filename: "<eval>" });
		// timeout aborts synchronous runaway loops (e.g. \`while(true){}\`) that
		// would otherwise block this event loop forever — stdin stops being read
		// and the parent only recovers via kill on its own timeout. vm only honors
		// it for sync execution; async work still relies on the parent timeout.
		const runOpts = timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs } : undefined;
		const result = script.runInContext(ctx, runOpts);
		if (result && typeof result.then === "function") {
			await result;
		}
	} catch (e) {
		error = e && e.stack ? e.stack : String(e);
	} finally {
		cap.restore();
	}
	return {
		stdout: cap.out.join("\\n"),
		stderr: cap.err.join("\\n"),
		error,
	};
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buf += chunk;
	let nl;
	while ((nl = buf.indexOf("\\n")) >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (!line) continue;
		let msg;
		try { msg = JSON.parse(line); } catch { continue; }
		runOne(msg.code, msg.timeoutMs, msg.maxBytes).then((r) => {
			process.stdout.write(JSON.stringify({ id: msg.id, ...r }) + "\\n");
		}, (e) => {
			process.stdout.write(JSON.stringify({ id: msg.id, error: String(e && e.stack || e) }) + "\\n");
		});
	}
});
process.stdin.on("end", () => process.exit(0));
`;

interface PendingCall {
	id: string;
	resolve(r: EvalResult): void;
	reject(e: Error): void;
	startedAt: number;
	timer: NodeJS.Timeout | undefined;
}

class JsKernel implements EvalKernel {
	private proc: ChildProcessWithoutNullStreams | undefined;
	private alive = false;
	private spawnError: Error | undefined;
	private pending = new Map<string, PendingCall>();
	private stdoutBuf = "";
	private cwd: string;
	private maxOutputBytes = resolveMaxEvalOutputBytes();

	constructor(cwd: string) {
		this.cwd = cwd;
		this.spawn();
	}

	private spawn(): void {
		try {
			const child = spawn(process.execPath, ["-e", DRIVER_SOURCE], {
				cwd: this.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env: process.env,
			});
			child.on("error", (err) => {
				this.spawnError = err as Error;
				this.alive = false;
				this.failPending(err as Error);
			});
			child.on("exit", () => {
				this.alive = false;
				this.failPending(new Error("node kernel exited"));
			});
			child.stdout.setEncoding("utf8");
			child.stderr.setEncoding("utf8");
			child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
			// Driver stderr is rare (uncaught errors only). Surface it as a fatal
			// kernel error against the most recent pending call.
			child.stderr.on("data", () => {
				// Intentionally swallow — uncaught driver errors will surface via exit.
			});
			this.proc = child;
			this.alive = true;
		} catch (err) {
			this.spawnError = err as Error;
			this.alive = false;
		}
	}

	private failPending(err: Error): void {
		const calls = Array.from(this.pending.values());
		this.pending.clear();
		for (const c of calls) {
			if (c.timer) clearTimeout(c.timer);
			c.reject(err);
		}
	}

	private onStdout(chunk: string): void {
		this.stdoutBuf += chunk;
		// Defensive: the child already caps captured output, but if a malformed or
		// runaway reply floods stdout without a newline the parse loop never drains
		// it and the buffer grows unbounded. Kill the kernel and fail the in-flight
		// call rather than OOM. Headroom over the child cap because a single reply
		// line is the capped payload plus JSON escaping (which can inflate it), so
		// only an unterminated flood well past that should ever trip this.
		const parentCap = this.maxOutputBytes * 4;
		if (this.stdoutBuf.length > parentCap && this.stdoutBuf.indexOf("\n") < 0) {
			const proc = this.proc;
			recordDiagnostic({
				category: "output.cap",
				level: "error",
				source: "eval-kernel.javascript",
				context: { bytes: this.stdoutBuf.length, pid: proc?.pid },
			});
			if (proc?.pid) killProcessTree(proc.pid);
			try {
				proc?.kill();
			} catch {
				// ignore
			}
			this.alive = false;
			this.stdoutBuf = "";
			this.failPending(new Error(`eval output exceeded ${this.maxOutputBytes} bytes (killed)`));
			return;
		}
		while (true) {
			const nl = this.stdoutBuf.indexOf("\n");
			if (nl < 0) break;
			const line = this.stdoutBuf.slice(0, nl);
			this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
			if (!line) continue;
			let msg: { id: string; stdout?: string; stderr?: string; error?: string };
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			const call = this.pending.get(msg.id);
			if (!call) continue;
			this.pending.delete(msg.id);
			if (call.timer) clearTimeout(call.timer);
			const result: EvalResult = {
				stdout: msg.stdout ?? "",
				stderr: msg.stderr ?? "",
				durationMs: Date.now() - call.startedAt,
			};
			if (msg.error) result.error = msg.error;
			call.resolve(result);
		}
	}

	isAlive(): boolean {
		return this.alive;
	}

	async exec(req: EvalRequest, signal?: AbortSignal): Promise<EvalResult> {
		if (!this.alive) {
			this.spawn();
			if (!this.alive) {
				throw this.spawnError ?? new Error("node kernel not alive");
			}
		}
		const proc = this.proc;
		if (!proc) {
			throw new Error("node kernel not alive");
		}
		const id = randomUUID();
		const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const parentTimeoutMs = timeoutMs + DRIVER_TIMEOUT_GRACE_MS;
		return new Promise<EvalResult>((resolve, reject) => {
			const call: PendingCall = { id, resolve, reject, startedAt: Date.now(), timer: undefined };
			call.timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					try {
						proc.kill();
					} catch {
						// ignore
					}
					this.alive = false;
					reject(new Error(`eval timed out after ${timeoutMs}ms`));
				}
			}, parentTimeoutMs);
			if (signal) {
				const onAbort = () => {
					if (this.pending.has(id)) {
						this.pending.delete(id);
						if (call.timer) clearTimeout(call.timer);
						try {
							proc.kill();
						} catch {
							// ignore
						}
						this.alive = false;
						reject(new Error("aborted"));
					}
				};
				if (signal.aborted) {
					onAbort();
					return;
				}
				signal.addEventListener("abort", onAbort, { once: true });
			}
			this.pending.set(id, call);
			proc.stdin.write(`${JSON.stringify({ id, code: req.code, timeoutMs, maxBytes: this.maxOutputBytes })}\n`);
		});
	}

	async close(): Promise<void> {
		this.alive = false;
		if (this.proc) {
			try {
				this.proc.stdin.end();
				this.proc.kill();
			} catch {
				// ignore
			}
			this.proc = undefined;
		}
		this.failPending(new Error("kernel closed"));
	}
}

export function createJsKernel(cwd: string): EvalKernel {
	return new JsKernel(cwd);
}
