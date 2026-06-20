/**
 * Debug Adapter Protocol transport: spawns the adapter process and speaks DAP
 * over stdio (most adapters) or a loopback TCP socket (e.g. `dlv`). Framing is
 * `Content-Length` headers over a byte stream, like LSP. Adapted from oh-my-pi
 * for Node's child_process + net.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as net from "node:net";
import type { Readable, Writable } from "node:stream";
import { recordDiagnostic } from "@pit/ai";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree } from "../../utils/shell.ts";
import { coalesceChunks } from "../lsp/frame-chunks.ts";
import { log, parseContentLengthFrame, toErrorMessage } from "../lsp/internal.ts";
import type {
	DapCapabilities,
	DapEventMessage,
	DapInitializeArguments,
	DapPendingRequest,
	DapRequestMessage,
	DapResolvedAdapter,
	DapResponseMessage,
} from "./types.ts";

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;
type DapReverseRequestHandler = (args: unknown) => unknown | Promise<unknown>;

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Socket-mode connect deadline; overridable (tests) via PIT_DAP_CONNECT_TIMEOUT_MS. */
function socketConnectTimeoutMs(): number {
	const override = Number.parseInt(process.env.PIT_DAP_CONNECT_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(override) && override > 0 ? override : 10_000;
}

/** Env that suppresses interactive prompts/pagers from the adapter or debuggee. */
export const NON_INTERACTIVE_ENV: Record<string, string> = {
	PAGER: "cat",
	GIT_PAGER: "cat",
	GIT_TERMINAL_PROMPT: "0",
	DEBIAN_FRONTEND: "noninteractive",
};

function parseMessage(
	buffer: Buffer,
):
	| { message: DapResponseMessage | DapEventMessage | DapRequestMessage; remaining: Buffer }
	| { error: Error; remaining: Buffer }
	| null {
	const frame = parseContentLengthFrame(buffer);
	if (!frame) return null;
	if ("error" in frame) return { error: frame.error, remaining: frame.remaining };
	return {
		message: frame.json as DapResponseMessage | DapEventMessage | DapRequestMessage,
		remaining: frame.remaining,
	};
}

export class DapClient {
	readonly adapter: DapResolvedAdapter;
	readonly cwd: string;
	readonly proc: ChildProcess;
	readonly #input: Readable;
	readonly #output: Writable;
	readonly #socket?: net.Socket;
	#requestSeq = 0;
	#pendingRequests = new Map<number, DapPendingRequest>();
	#messageBuffer: Buffer = Buffer.alloc(0);
	/** Raw chunks awaiting coalesce into #messageBuffer (avoids per-chunk O(B²) concat). */
	#pendingChunks: Buffer[] = [];
	#isReading = false;
	#disposed = false;
	#lastActivity = Date.now();
	#capabilities?: DapCapabilities;
	#stderr = "";
	#eventHandlers = new Map<string, Set<DapEventHandler>>();
	#reverseRequestHandlers = new Map<string, DapReverseRequestHandler>();

	constructor(
		adapter: DapResolvedAdapter,
		cwd: string,
		proc: ChildProcess,
		options: { input: Readable; output: Writable; socket?: net.Socket },
	) {
		this.adapter = adapter;
		this.cwd = cwd;
		this.proc = proc;
		this.#input = options.input;
		this.#output = options.output;
		this.#socket = options.socket;
	}

	static async spawn({ adapter, cwd }: { adapter: DapResolvedAdapter; cwd: string }): Promise<DapClient> {
		if (adapter.connectMode === "socket") {
			return DapClient.#spawnSocket({ adapter, cwd });
		}
		const env = { ...process.env, ...NON_INTERACTIVE_ENV };
		const proc = spawn(adapter.resolvedCommand, adapter.args, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env,
			// Own process group on POSIX so the debuggee can't reach the harness's
			// controlling terminal (SIGTTIN). Windows has no such concept.
			detached: process.platform !== "win32",
			windowsHide: true,
		});
		if (!proc.stdout || !proc.stdin) {
			throw new Error(`DAP adapter ${adapter.name} did not expose stdio pipes`);
		}
		const client = new DapClient(adapter, cwd, proc, { input: proc.stdout, output: proc.stdin });
		client.#attachProcess();
		client.#startReading();
		return client;
	}

	/**
	 * Socket-mode adapter (e.g. dlv): listen on a loopback TCP port and have the
	 * adapter dial in via `--client-addr`. Portable across Linux/macOS/Windows.
	 */
	static async #spawnSocket({ adapter, cwd }: { adapter: DapResolvedAdapter; cwd: string }): Promise<DapClient> {
		const env = { ...process.env, ...NON_INTERACTIVE_ENV };
		const server = net.createServer();
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;

		const connPromise = new Promise<net.Socket>((resolve, reject) => {
			server.once("connection", resolve);
			server.once("error", reject);
		});

		const proc = spawn(adapter.resolvedCommand, [...adapter.args, `--client-addr=127.0.0.1:${port}`], {
			cwd,
			// stdout is ignored (not piped): the socket carries DAP, and an undrained
			// stdout pipe could fill its OS buffer and stall a chatty adapter.
			stdio: ["ignore", "ignore", "pipe"],
			env,
			detached: process.platform !== "win32",
			windowsHide: true,
		});

		// Capture stderr and a spawn 'error' BEFORE the connect race: an EACCES/EPERM
		// (or the process dying) inside the connect window would otherwise be an
		// unhandled 'error' event and crash the host. We collect the failure here and
		// surface it as a race rejection; on success we detach and #attachExit takes over.
		let earlyStderr = "";
		const onEarlyStderr = (chunk: Buffer) => {
			earlyStderr = (earlyStderr + chunk.toString("utf-8")).slice(-64 * 1024);
		};
		proc.stderr?.on("data", onEarlyStderr);
		let connected = false;
		let onEarlyError!: (err: Error) => void;
		const spawnErrorPromise = new Promise<never>((_, reject) => {
			onEarlyError = (err) => {
				const detail = earlyStderr.trim();
				reject(new Error(detail ? `${adapter.name} failed to start: ${String(err)}: ${detail}` : String(err)));
			};
			proc.once("error", onEarlyError);
		});

		let socket: net.Socket;
		const connectTimeoutMs = socketConnectTimeoutMs();
		let timeoutHandle!: ReturnType<typeof setTimeout>;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				// Surface the connect-timeout that kills the adapter (covers the kill too).
				recordDiagnostic({
					category: "net.connect-timeout",
					level: "error",
					source: "dap.spawnSocket",
					context: { pid: proc.pid, ms: connectTimeoutMs },
				});
				reject(new Error(`${adapter.name} did not connect within 10s`));
			}, connectTimeoutMs);
			timeoutHandle.unref?.();
		});
		try {
			socket = await Promise.race([connPromise, spawnErrorPromise, timeoutPromise]);
			connected = true;
		} finally {
			// Cancel the connect-timeout the moment the race settles, regardless of which
			// branch won, so a successful connect can't fire a spurious error diagnostic
			// (or leave the timer object lingering) ~10s later.
			clearTimeout(timeoutHandle);
			server.close();
			// Detach the bootstrap listeners so the happy path matches the prior wiring
			// exactly (only #captureStderr / #attachExit remain active).
			proc.stderr?.off("data", onEarlyStderr);
			proc.off("error", onEarlyError);
			// On timeout or spawn error we never connected: kill the leaked adapter
			// tree (it may still dial in later to a closed server) instead of orphaning it.
			if (!connected) {
				// No DapClient is created on this path, so nothing else will listen for
				// 'error'. Keep a no-op guard so a late spawn error can't crash the host.
				proc.on("error", () => {});
				try {
					if (proc.pid) killProcessTree(proc.pid);
					else proc.kill();
				} catch {
					/* already gone */
				}
			}
		}

		const client = new DapClient(adapter, cwd, proc, { input: socket, output: socket, socket });
		client.#captureStderr();
		client.#attachExit();
		client.#startReading();
		return client;
	}

	get capabilities(): DapCapabilities | undefined {
		return this.#capabilities;
	}

	get lastActivity(): number {
		return this.#lastActivity;
	}

	isAlive(): boolean {
		return !this.#disposed && this.proc.exitCode === null;
	}

	async initialize(args: DapInitializeArguments, signal?: AbortSignal, timeoutMs?: number): Promise<DapCapabilities> {
		const body = (await this.sendRequest("initialize", args, signal, timeoutMs)) as DapCapabilities | undefined;
		this.#capabilities = body ?? {};
		return this.#capabilities;
	}

	onEvent(event: string, handler: DapEventHandler): () => void {
		const handlers = this.#eventHandlers.get(event) ?? new Set<DapEventHandler>();
		handlers.add(handler);
		this.#eventHandlers.set(event, handlers);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.#eventHandlers.delete(event);
		};
	}

	onReverseRequest(command: string, handler: DapReverseRequestHandler): () => void {
		this.#reverseRequestHandlers.set(command, handler);
		return () => {
			if (this.#reverseRequestHandlers.get(command) === handler) {
				this.#reverseRequestHandlers.delete(command);
			}
		};
	}

	async waitForEvent<TBody>(
		event: string,
		predicate?: (body: TBody) => boolean,
		signal?: AbortSignal,
		timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<TBody> {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		return new Promise<TBody>((resolve, reject) => {
			let timeout: NodeJS.Timeout | undefined;
			const cleanup = () => {
				unsubscribe();
				if (timeout) clearTimeout(timeout);
				if (signal) signal.removeEventListener("abort", abortHandler);
			};
			const abortHandler = () => {
				cleanup();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
			};
			const unsubscribe = this.onEvent(event, (body) => {
				const typed = body as TBody;
				if (predicate && !predicate(typed)) return;
				cleanup();
				resolve(typed);
			});
			if (signal) signal.addEventListener("abort", abortHandler, { once: true });
			timeout = setTimeout(() => {
				cleanup();
				reject(new Error(`DAP event ${event} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
	}

	async sendRequest<TBody = unknown>(
		command: string,
		args?: unknown,
		signal?: AbortSignal,
		timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<TBody> {
		if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
		if (this.#disposed) throw new Error(`DAP adapter ${this.adapter.name} is not running`);

		const requestSeq = ++this.#requestSeq;
		const request: DapRequestMessage = { seq: requestSeq, type: "request", command, arguments: args };

		return new Promise<TBody>((resolve, reject) => {
			let timeout: NodeJS.Timeout | undefined;
			const cleanup = () => {
				if (timeout) clearTimeout(timeout);
				if (signal) signal.removeEventListener("abort", abortHandler);
			};
			const abortHandler = () => {
				this.#pendingRequests.delete(requestSeq);
				cleanup();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
			};
			timeout = setTimeout(() => {
				if (!this.#pendingRequests.has(requestSeq)) return;
				this.#pendingRequests.delete(requestSeq);
				cleanup();
				reject(new Error(`DAP request ${command} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			if (signal) signal.addEventListener("abort", abortHandler, { once: true });
			this.#pendingRequests.set(requestSeq, {
				command,
				resolve: (body) => {
					cleanup();
					resolve(body as TBody);
				},
				reject: (error) => {
					cleanup();
					reject(error);
				},
			});
			this.#lastActivity = Date.now();
			try {
				this.#write(request);
			} catch (error) {
				this.#pendingRequests.delete(requestSeq);
				cleanup();
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	async sendResponse(request: DapRequestMessage, success: boolean, body?: unknown, message?: string): Promise<void> {
		const response: DapResponseMessage = {
			seq: ++this.#requestSeq,
			type: "response",
			request_seq: request.seq,
			success,
			command: request.command,
			...(message ? { message } : {}),
			...(body !== undefined ? { body } : {}),
		};
		this.#write(response);
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#rejectPendingRequests(new Error(`DAP adapter ${this.adapter.name} disposed`));
		try {
			this.#socket?.destroy();
		} catch {
			/* already closed */
		}
		try {
			if (this.proc.pid) killProcessTree(this.proc.pid);
			else this.proc.kill();
		} catch (error) {
			log.error("Failed to kill DAP adapter", { adapter: this.adapter.name, error: toErrorMessage(error) });
		}
		await waitForChildProcess(this.proc).catch(() => {});
	}

	// ===========================================================================
	// Transport wiring
	// ===========================================================================

	#write(message: DapRequestMessage | DapResponseMessage): void {
		const content = JSON.stringify(message);
		this.#output.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`);
		this.#output.write(content);
	}

	#attachProcess(): void {
		this.#captureStderr();
		this.#attachExit();
		// Swallow stdin EPIPE so a dead adapter doesn't crash the host.
		this.proc.stdin?.on("error", () => {});
	}

	#captureStderr(): void {
		this.proc.stderr?.on("data", (chunk: Buffer) => {
			if (this.#stderr.length < 64 * 1024) {
				this.#stderr = (this.#stderr + chunk.toString("utf-8")).slice(-64 * 1024);
			}
		});
	}

	#attachExit(): void {
		this.proc.on("exit", () => this.#handleProcessExit());
		this.proc.on("error", (err) => {
			this.#stderr += `\n${String(err)}`;
			this.#handleProcessExit();
		});
	}

	#startReading(): void {
		this.#input.on("data", (chunk: Buffer) => this.#onData(chunk));
		this.#input.on("error", (err) => {
			this.#rejectPendingRequests(new Error(`DAP connection error: ${toErrorMessage(err)}`));
			// A transport (socket/pipe) error leaves the session unusable even when the
			// adapter PROCESS is still alive (e.g. ECONNRESET on a dlv socket). Mark it
			// disposed and tear it down so isAlive() turns false and #ensureLaunchSlot
			// does not block new launches on a zombie session until the idle timeout (#29).
			void this.dispose();
		});
	}

	#onData(chunk: Buffer): void {
		this.#pendingChunks.push(chunk);
		void this.#drain();
	}

	#coalescePending(): void {
		if (this.#pendingChunks.length === 0) return;
		this.#messageBuffer = coalesceChunks(this.#messageBuffer, this.#pendingChunks);
		this.#pendingChunks.length = 0;
	}

	async #drain(): Promise<void> {
		if (this.#isReading) return;
		this.#isReading = true;
		try {
			this.#coalescePending();
			let parsed = parseMessage(this.#messageBuffer);
			while (parsed) {
				this.#messageBuffer = parsed.remaining;
				this.#lastActivity = Date.now();
				if ("error" in parsed) {
					log.warn("Discarding malformed DAP frame", { error: parsed.error.message });
					this.#coalescePending();
					parsed = parseMessage(this.#messageBuffer);
					continue;
				}
				const message = parsed.message;
				if (message.type === "response") {
					this.#handleResponse(message);
				} else if (message.type === "event") {
					await this.#dispatchEvent(message);
				} else {
					await this.#handleAdapterRequest(message);
				}
				// Chunks may have arrived during the await; fold them in before re-parsing.
				this.#coalescePending();
				parsed = parseMessage(this.#messageBuffer);
			}
		} catch (error) {
			log.error("DAP message reader error", { error: toErrorMessage(error) });
		} finally {
			this.#isReading = false;
		}
		if (this.#pendingChunks.length > 0 || parseMessage(this.#messageBuffer)) void this.#drain();
	}

	#handleResponse(message: DapResponseMessage): void {
		const pending = this.#pendingRequests.get(message.request_seq);
		if (!pending) return;
		this.#pendingRequests.delete(message.request_seq);
		if (message.success) {
			pending.resolve(message.body);
			return;
		}
		pending.reject(new Error(message.message ?? `DAP request ${pending.command} failed`));
	}

	async #dispatchEvent(message: DapEventMessage): Promise<void> {
		for (const handler of Array.from(this.#eventHandlers.get(message.event) ?? [])) {
			try {
				await handler(message.body, message);
			} catch (error) {
				log.warn("DAP event handler failed", { event: message.event, error: toErrorMessage(error) });
			}
		}
	}

	async #handleAdapterRequest(message: DapRequestMessage): Promise<void> {
		try {
			const handler = this.#reverseRequestHandlers.get(message.command);
			if (handler) {
				try {
					const body = await handler(message.arguments);
					await this.sendResponse(message, true, body);
				} catch (error) {
					const errorMessage = toErrorMessage(error);
					await this.sendResponse(message, false, { error: { id: 1, format: errorMessage } }, errorMessage);
				}
				return;
			}
			const errorMessage = `Unsupported DAP request: ${message.command}`;
			await this.sendResponse(message, false, { error: { id: 1, format: errorMessage } }, errorMessage);
		} catch (error) {
			log.warn("Failed to answer DAP adapter request", { command: message.command, error: toErrorMessage(error) });
		}
	}

	#handleProcessExit(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		const stderr = this.#stderr.trim();
		const exitCode = this.proc.exitCode;
		const error = new Error(
			stderr
				? `DAP adapter exited (code ${exitCode}): ${stderr}`
				: `DAP adapter exited unexpectedly (code ${exitCode})`,
		);
		this.#rejectPendingRequests(error);
	}

	#rejectPendingRequests(error: Error): void {
		for (const pending of this.#pendingRequests.values()) pending.reject(error);
		this.#pendingRequests.clear();
	}
}
