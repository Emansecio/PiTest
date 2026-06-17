/**
 * Stdio transport — speaks JSON-RPC over a subprocess's stdin/stdout using the
 * same `Content-Length` framing as the LSP/DAP clients. This is how local MCP
 * servers (the npm `@modelcontextprotocol/server-*` family, Desktop Commander,
 * etc.) are launched. Reuses the project's cross-platform spawn + framing +
 * process-lifecycle primitives rather than re-deriving them:
 *  - `spawnProcess` / `waitForChildProcess` (utils/child-process.ts)
 *  - `needsWindowsShell` / `quoteWindowsShellArg` (lsp/internal.ts)
 *  - `resolveCommand` (lsp/config.ts) for project-local-bin-then-PATH resolution
 *  - `parseContentLengthFrame` (lsp/internal.ts) — shared LSP/DAP frame parser
 */

import type { ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { recordDiagnostic } from "@pit/ai";
import { spawnProcess, waitForChildProcess } from "../../../utils/child-process.ts";
import { killProcessTree } from "../../../utils/shell.ts";
import { resolveCommand } from "../../lsp/config.ts";
import { needsWindowsShell, parseContentLengthFrame, quoteWindowsShellArg } from "../../lsp/internal.ts";
import type { McpServerConfig } from "../types.ts";
import {
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type McpTransport,
	McpTransportError,
} from "./types.ts";

/** Cap retained stderr so a chatty server can't grow memory unbounded. */
const MAX_STDERR_BYTES = 64 * 1024;

// Best-effort safety net: if the host exits without a graceful dispose (crash,
// SIGKILL of the agent), don't leak the spawned MCP server subprocesses. Mirrors
// the LSP client's exit hook. Registered lazily on the first spawn.
const liveStdioProcs = new Set<StdioChild>();
let exitHookRegistered = false;
function registerStdioExitHook(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	process.on("exit", () => {
		for (const proc of liveStdioProcs) {
			try {
				proc.kill();
			} catch {
				// ignore
			}
		}
	});
}

interface Pending {
	resolve: (response: JsonRpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

type StdioChild = ChildProcessByStdio<Writable, Readable, Readable>;

export class StdioTransport implements McpTransport {
	private name: string;
	private config: McpServerConfig;
	private proc?: StdioChild;
	private buffer: Buffer = Buffer.alloc(0);
	private isReading = false;
	private pending = new Map<number | string, Pending>();
	private stderrBuffer = "";
	private exited = false;
	private exitError?: Error;

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
	}

	updateConfig(config: McpServerConfig): void {
		this.config = config;
	}

	async start(): Promise<void> {
		// A reconnect re-runs start() on the same instance: tear down any stale
		// process first so we always hand the handshake a fresh subprocess.
		this.killProc();
		this.buffer = Buffer.alloc(0);
		this.exited = false;
		this.exitError = undefined;
		this.stderrBuffer = "";

		const command = this.config.command;
		if (!command) {
			throw new McpTransportError(`MCP ${this.name}: stdio transport requires a "command"`);
		}
		const cwd = this.config.cwd ?? process.cwd();
		const resolved = resolveCommand(command, cwd) ?? command;
		const args = this.config.args ?? [];

		// Node ≥ 20.12 rejects spawning a Windows `.cmd`/`.bat` directly (EINVAL),
		// so route script launchers (npx, server shims) through a shell with each
		// argv element quoted. Native binaries spawn directly.
		const useShell = needsWindowsShell(resolved);
		const spawnCommand = useShell ? quoteWindowsShellArg(resolved) : resolved;
		const spawnArgs = useShell ? args.map(quoteWindowsShellArg) : args;

		const proc = spawnProcess(spawnCommand, spawnArgs, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			// MCP servers read their config from env (tokens, paths). Merge the
			// configured env over the inherited one so the server still sees PATH etc.
			env: { ...process.env, ...(this.config.env ?? {}) },
			windowsHide: true,
			shell: useShell,
		}) as StdioChild;
		this.proc = proc;
		registerStdioExitHook();
		liveStdioProcs.add(proc);

		proc.stdout.on("data", (chunk: Buffer) => this.onStdoutData(chunk));
		proc.stderr.on("data", (chunk: Buffer) => {
			if (this.stderrBuffer.length < MAX_STDERR_BYTES) {
				this.stderrBuffer = (this.stderrBuffer + chunk.toString("utf-8")).slice(-MAX_STDERR_BYTES);
			}
		});
		// Swallow stdin EPIPE so a dead server doesn't crash the host process.
		proc.stdin.on("error", () => {});
		proc.on("exit", (code) => this.onExit(code));
		proc.on("error", (err) => {
			this.stderrBuffer = `${this.stderrBuffer}${String(err)}\n`.slice(-MAX_STDERR_BYTES);
			this.onExit(null);
		});
	}

	private onExit(code: number | null): void {
		if (this.exited) return;
		this.exited = true;
		if (this.proc) liveStdioProcs.delete(this.proc);
		const stderr = this.stderrBuffer.trim();
		this.exitError = new McpTransportError(
			stderr
				? `MCP ${this.name}: server exited (code ${code}): ${stderr.slice(-2000)}`
				: `MCP ${this.name}: server exited unexpectedly (code ${code})`,
		);
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(this.exitError);
		}
		this.pending.clear();
	}

	private onStdoutData(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		this.drain();
	}

	private drain(): void {
		if (this.isReading) return;
		this.isReading = true;
		try {
			let frame = parseContentLengthFrame(this.buffer);
			while (frame) {
				this.buffer = frame.remaining;
				if ("error" in frame) {
					recordDiagnostic({
						category: "output.cap",
						level: "warn",
						source: "mcp.stdio",
						context: { note: `discarded malformed frame: ${frame.error.message}` },
					});
				} else {
					this.routeMessage(frame.json);
				}
				frame = parseContentLengthFrame(this.buffer);
			}
		} finally {
			this.isReading = false;
		}
		// A chunk may have arrived after the last parse but before the flag cleared.
		if (parseContentLengthFrame(this.buffer)) this.drain();
	}

	private routeMessage(json: unknown): void {
		if (!json || typeof json !== "object") return;
		const msg = json as JsonRpcResponse & { method?: string };
		// Server-initiated notifications/requests (no id, or a method we don't
		// implement) are ignored — Pit does not expose sampling/roots back.
		if (!("id" in msg) || msg.id === undefined || msg.id === null) return;
		const p = this.pending.get(msg.id);
		if (!p) return;
		this.pending.delete(msg.id);
		clearTimeout(p.timer);
		p.resolve(msg);
	}

	private writeFrame(payload: JsonRpcRequest | JsonRpcNotification): void {
		const body = Buffer.from(JSON.stringify(payload), "utf-8");
		const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
		this.proc?.stdin.write(Buffer.concat([header, body]));
	}

	async request<T = unknown>(
		message: JsonRpcRequest,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<JsonRpcResponse<T>> {
		if (!this.proc || this.exited) {
			throw this.exitError ?? new McpTransportError(`MCP ${this.name}: stdio transport not started`);
		}
		const effectiveTimeout = timeoutMs ?? this.config.timeoutMs ?? 30_000;
		return new Promise<JsonRpcResponse<T>>((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
				return;
			}
			const onAbort = () => {
				this.pending.delete(message.id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
			};
			const timer = setTimeout(() => {
				this.pending.delete(message.id);
				signal?.removeEventListener("abort", onAbort);
				reject(new McpTransportError(`MCP ${this.name} ${message.method}: timed out after ${effectiveTimeout}ms`));
			}, effectiveTimeout);
			this.pending.set(message.id, {
				resolve: (r) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(r as JsonRpcResponse<T>);
				},
				reject: (e) => {
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				},
				timer,
			});
			signal?.addEventListener("abort", onAbort, { once: true });
			try {
				this.writeFrame(message);
			} catch (err) {
				this.pending.delete(message.id);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				reject(new McpTransportError(`MCP ${this.name} ${message.method}: write failed (${String(err)})`));
			}
		});
	}

	async notify(message: JsonRpcNotification): Promise<void> {
		if (!this.proc || this.exited) return;
		try {
			this.writeFrame(message);
		} catch {
			/* non-fatal */
		}
	}

	private killProc(): void {
		const proc = this.proc;
		if (!proc) return;
		this.proc = undefined;
		liveStdioProcs.delete(proc);
		try {
			if (typeof proc.pid === "number") killProcessTree(proc.pid);
			else proc.kill();
		} catch {
			/* ignore */
		}
		void waitForChildProcess(proc).catch(() => {});
	}

	dispose(): void {
		this.exited = true;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(new McpTransportError(`MCP ${this.name}: transport disposed`));
		}
		this.pending.clear();
		this.killProc();
	}
}
