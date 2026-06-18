/**
 * LSP client process lifecycle and JSON-RPC over stdio.
 *
 * One process per `command:cwd`. Outbound writes are serialized; inbound
 * messages are framed by `Content-Length` headers and parsed from a byte
 * buffer (no string decoding before the frame boundary, so multi-byte content
 * is length-correct). Adapted from oh-my-pi for Node's child_process.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { recordDiagnostic } from "@pit/ai";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { killProcessTree } from "../../utils/shell.ts";
import { applyWorkspaceEdit } from "./edits.ts";
import { coalesceChunks } from "./frame-chunks.ts";
import {
	isEnoent,
	log,
	needsWindowsShell,
	parseContentLengthFrame,
	quoteWindowsShellArg,
	sleep,
	throwIfAborted,
	untilAborted,
} from "./internal.ts";
import type {
	LspClient,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	PublishDiagnosticsParams,
	ServerConfig,
	WorkspaceEdit,
} from "./types.ts";
import { detectLanguageId, fileToUri } from "./utils.ts";

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, LspClient>();
const clientLocks = new Map<string, Promise<LspClient>>();
const fileOperationLocks = new Map<string, Promise<void>>();

// Best-effort safety net: if the host exits without a graceful session dispose,
// don't leak language-server processes. Registered lazily on first client.
let exitHookRegistered = false;
function registerExitHook(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	process.on("exit", () => {
		for (const client of clients.values()) {
			try {
				client.proc.kill();
			} catch {
				// ignore
			}
		}
	});
}

let idleTimeoutMs: number | null = null;
let idleCheckInterval: NodeJS.Timeout | null = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

export function setIdleTimeout(ms: number | null | undefined): void {
	idleTimeoutMs = ms ?? null;
	if (idleTimeoutMs && idleTimeoutMs > 0) startIdleChecker();
	else stopIdleChecker();
}

function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = setInterval(() => {
		if (!idleTimeoutMs) return;
		const now = Date.now();
		for (const [key, client] of Array.from(clients.entries())) {
			if (now - client.lastActivity > idleTimeoutMs) {
				void shutdownClient(key);
			}
		}
	}, IDLE_CHECK_INTERVAL_MS);
	// Don't keep the event loop alive just for idle sweeps.
	idleCheckInterval.unref?.();
}

function stopIdleChecker(): void {
	if (idleCheckInterval) {
		clearInterval(idleCheckInterval);
		idleCheckInterval = null;
	}
}

// =============================================================================
// Client Capabilities
// =============================================================================

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: { didSave: true, dynamicRegistration: false, willSave: false, willSaveWaitUntil: false },
		hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
		definition: { dynamicRegistration: false, linkSupport: true },
		typeDefinition: { dynamicRegistration: false, linkSupport: true },
		implementation: { dynamicRegistration: false, linkSupport: true },
		references: { dynamicRegistration: false },
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		rename: { dynamicRegistration: false, prepareSupport: true },
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
						"source.fixAll",
					],
				},
			},
			resolveSupport: { properties: ["edit"] },
		},
		formatting: { dynamicRegistration: false },
		rangeFormatting: { dynamicRegistration: false },
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
	},
	window: { workDoneProgress: true },
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "textOnlyTransactional",
		},
		configuration: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		fileOperations: {
			dynamicRegistration: false,
			willCreate: false,
			didCreate: false,
			willRename: true,
			didRename: true,
			willDelete: false,
			didDelete: false,
		},
	},
	experimental: { snippetTextEdit: true },
};

// =============================================================================
// LSP Message Framing
// =============================================================================

function parseMessage(
	buffer: Buffer,
):
	| { message: LspJsonRpcResponse | LspJsonRpcNotification; remaining: Buffer }
	| { error: Error; remaining: Buffer }
	| null {
	const frame = parseContentLengthFrame(buffer);
	if (!frame) return null;
	if ("error" in frame) return { error: frame.error, remaining: frame.remaining };
	return { message: frame.json as LspJsonRpcResponse | LspJsonRpcNotification, remaining: frame.remaining };
}

function writeMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): void {
	const content = JSON.stringify(message);
	const header = `Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n`;
	client.proc.stdin.write(header + content);
}

function queueWriteMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
): Promise<void> {
	const write = client.writeQueue.catch(() => {}).then(() => writeMessage(client, message));
	client.writeQueue = write.catch(() => {});
	return write;
}

// =============================================================================
// Message Reader
// =============================================================================

function onStdoutData(client: LspClient, chunk: Buffer): void {
	client.pendingChunks.push(chunk);
	void drainMessages(client);
}

async function drainMessages(client: LspClient): Promise<void> {
	if (client.isReading) return;
	client.isReading = true;
	try {
		if (client.pendingChunks.length > 0) {
			client.messageBuffer = coalesceChunks(client.messageBuffer, client.pendingChunks);
			client.pendingChunks.length = 0;
		}
		let parsed = parseMessage(client.messageBuffer);
		while (parsed) {
			client.messageBuffer = parsed.remaining;
			if ("error" in parsed) {
				log.warn("Discarding malformed LSP frame", { error: parsed.error.message });
			} else {
				await routeMessage(client, parsed.message);
			}
			// Chunks may have arrived during the await; fold them in before re-parsing.
			if (client.pendingChunks.length > 0) {
				client.messageBuffer = coalesceChunks(client.messageBuffer, client.pendingChunks);
				client.pendingChunks.length = 0;
			}
			parsed = parseMessage(client.messageBuffer);
		}
	} catch (err) {
		log.error("LSP message reader error", { error: String(err) });
	} finally {
		client.isReading = false;
	}
	// A chunk may have arrived after the last parse but before the flag cleared.
	if (client.pendingChunks.length > 0 || parseMessage(client.messageBuffer)) void drainMessages(client);
}

async function routeMessage(client: LspClient, message: LspJsonRpcResponse | LspJsonRpcNotification): Promise<void> {
	if ("id" in message && message.id !== undefined) {
		const pending = client.pendingRequests.get(message.id as number);
		if (pending) {
			client.pendingRequests.delete(message.id as number);
			if ("error" in message && message.error) {
				pending.reject(new Error(`LSP error: ${message.error.message}`));
			} else {
				pending.resolve(message.result);
			}
		} else if ("method" in message) {
			await handleServerRequest(client, message as unknown as LspJsonRpcRequest);
		}
	} else if ("method" in message) {
		const notification = message as LspJsonRpcNotification;
		if (notification.method === "textDocument/publishDiagnostics" && notification.params) {
			const params = notification.params as PublishDiagnosticsParams;
			client.diagnostics.set(params.uri, {
				diagnostics: params.diagnostics,
				version: params.version ?? null,
			});
			client.diagnosticsVersion += 1;
		} else if (notification.method === "$/progress" && notification.params) {
			const params = notification.params as { token: string | number; value?: { kind?: string } };
			if (params.value?.kind === "begin") {
				client.activeProgressTokens.add(params.token);
			} else if (params.value?.kind === "end") {
				client.activeProgressTokens.delete(params.token);
				if (client.activeProgressTokens.size === 0) client.resolveProjectLoaded();
			}
		}
	}
}

async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map((item) => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? {};
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (typeof message.id !== "number") return;
	const params = message.params as { edit?: WorkspaceEdit };
	if (!params?.edit) {
		await sendResponse(
			client,
			message.id,
			{ applied: false, failureReason: "No edit provided" },
			"workspace/applyEdit",
		);
		return;
	}
	try {
		await applyWorkspaceEdit(params.edit, client.cwd);
		await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
	} catch (err) {
		await sendResponse(client, message.id, { applied: false, failureReason: String(err) }, "workspace/applyEdit");
	}
}

async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await handleConfigurationRequest(client, message);
		return;
	}
	if (message.method === "workspace/applyEdit") {
		await handleApplyEditRequest(client, message);
		return;
	}
	if (message.method === "window/workDoneProgress/create") {
		if (typeof message.id === "number") await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (typeof message.id !== "number") return;
	await sendResponse(client, message.id, null, message.method, {
		code: -32601,
		message: `Method not found: ${message.method}`,
	});
}

async function sendResponse(
	client: LspClient,
	id: number,
	result: unknown,
	method: string,
	error?: { code: number; message: string; data?: unknown },
): Promise<void> {
	const response: LspJsonRpcResponse = { jsonrpc: "2.0", id, ...(error ? { error } : { result }) };
	try {
		await queueWriteMessage(client, response);
	} catch (err) {
		log.error("LSP failed to respond.", { method, error: String(err) });
	}
}

// =============================================================================
// Client Management
// =============================================================================

/** Timeout for warmup initialize requests (5 seconds). */
export const WARMUP_TIMEOUT_MS = 5000;
/** Max time to wait for the server to report project loading via $/progress. */
const PROJECT_LOAD_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
/** Cap retained stderr so a chatty server can't grow memory unbounded. */
const MAX_STDERR_BYTES = 64 * 1024;

export async function getOrCreateClient(config: ServerConfig, cwd: string, initTimeoutMs?: number): Promise<LspClient> {
	registerExitHook();
	const key = `${config.command}:${cwd}`;

	const existingClient = clients.get(key);
	if (existingClient) {
		existingClient.lastActivity = Date.now();
		return existingClient;
	}
	const existingLock = clientLocks.get(key);
	if (existingLock) return existingLock;

	const clientPromise = (async () => {
		const command = config.resolvedCommand ?? config.command;
		const args = config.args ?? [];

		// Node ≥ 20.12 rejects spawning a Windows `.cmd`/`.bat` directly (EINVAL),
		// so route script launchers (typescript-language-server, biome, pyright…)
		// through a shell with each argv element quoted. Native binaries spawn
		// directly as before.
		const useShell = needsWindowsShell(command);
		const spawnCommand = useShell ? quoteWindowsShellArg(command) : command;
		const spawnArgs = useShell ? args.map(quoteWindowsShellArg) : args;
		const proc = spawn(spawnCommand, spawnArgs, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.env,
			windowsHide: true,
			shell: useShell,
		}) as ChildProcessWithoutNullStreams;

		let resolveProjectLoaded!: () => void;
		const projectLoaded = new Promise<void>((resolve) => {
			resolveProjectLoaded = resolve;
		});
		const projectLoadTimeout = setTimeout(() => resolveProjectLoaded(), PROJECT_LOAD_TIMEOUT_MS);
		projectLoadTimeout.unref?.();
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => {
			clearTimeout(projectLoadTimeout);
			originalResolve();
		};

		const client: LspClient = {
			name: key,
			cwd,
			proc,
			config,
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: Buffer.alloc(0),
			pendingChunks: [],
			isReading: false,
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded,
			resolveProjectLoaded,
			stderrBuffer: "",
			exitCode: null,
		};
		// NOTE: do NOT publish to `clients` yet — only after initialize+initialized
		// complete (below). Publishing here would let a concurrent caller hit the
		// clients.get fast-path and use a server that hasn't seen `initialize`,
		// emitting requests it may reject. In-flight callers de-dup via clientLocks.

		proc.stdout.on("data", (chunk: Buffer) => onStdoutData(client, chunk));
		proc.stderr.on("data", (chunk: Buffer) => {
			if (client.stderrBuffer.length < MAX_STDERR_BYTES) {
				client.stderrBuffer = (client.stderrBuffer + chunk.toString("utf-8")).slice(-MAX_STDERR_BYTES);
			}
		});
		// Swallow stdin EPIPE so a dead server doesn't crash the host process.
		proc.stdin.on("error", () => {});

		const onExit = (code: number | null) => {
			client.exitCode = code;
			clients.delete(key);
			clientLocks.delete(key);
			client.resolveProjectLoaded();
			if (client.pendingRequests.size > 0) {
				const stderr = client.stderrBuffer
					.split("\n")
					.filter((line) => !/^\[\d{2}:\d{2}:\d{2} (?:INF|DBG|VRB)\]/.test(line))
					.join("\n")
					.trim();
				const err = new Error(
					stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`,
				);
				for (const pending of client.pendingRequests.values()) pending.reject(err);
				client.pendingRequests.clear();
			}
		};
		proc.on("exit", onExit);
		proc.on("error", (err) => {
			// Spawn failure (e.g. ENOENT). Reject the init lock via exit path.
			// Apply the same cap the data handler uses so a flood here can't grow
			// the buffer unbounded (parity with the :data path above).
			client.stderrBuffer = `${client.stderrBuffer}${String(err)}\n`.slice(-MAX_STDERR_BYTES);
			onExit(proc.exitCode);
		});

		try {
			const initResult = (await sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd),
					rootPath: cwd,
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: [{ uri: fileToUri(cwd), name: cwd.split(/[\\/]/).pop() ?? "workspace" }],
				},
				undefined,
				initTimeoutMs,
			)) as { capabilities?: unknown };

			if (!initResult) throw new Error("Failed to initialize LSP: no response");
			client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];
			await sendNotification(client, "initialized", {});
			// Publish only now that the server has seen initialize + initialized, so a
			// concurrent clients.get fast-path can't return a pre-init server.
			clients.set(key, client);
			return client;
		} catch (err) {
			clients.delete(key);
			clientLocks.delete(key);
			try {
				proc.kill();
			} catch {
				// ignore
			}
			throw err;
		} finally {
			clientLocks.delete(key);
		}
	})();

	clientLocks.set(key, clientPromise);
	return clientPromise;
}

export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	if (client.openFiles.has(uri)) return;

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
		return;
	}

	const openPromise = (async () => {
		throwIfAborted(signal);
		if (client.openFiles.has(uri)) return;
		let content: string;
		try {
			content = await fs.readFile(filePath, "utf-8");
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const languageId = detectLanguageId(filePath);
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didOpen", {
			textDocument: { uri, languageId, version: 1, text: content },
		});
		client.openFiles.set(uri, { version: 1, languageId });
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, openPromise);
	try {
		await openPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/**
 * Wait for the server's initial project loading to complete. Races the server's
 * $/progress tracking against the abort signal; returns immediately if already
 * complete or timed out.
 */
export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	await Promise.race([
		client.projectLoaded,
		...(signal
			? [new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))]
			: []),
	]);
}

/** Sync in-memory content to the server (didOpen if new, didChange if open). */
export async function syncContent(
	client: LspClient,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	throwIfAborted(signal);

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) await untilAborted(signal, () => existingLock);

	const syncPromise = (async () => {
		client.diagnostics.delete(uri);
		const info = client.openFiles.get(uri);
		if (!info) {
			const languageId = detectLanguageId(filePath);
			throwIfAborted(signal);
			await sendNotification(client, "textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text: content },
			});
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
			return;
		}
		const version = ++info.version;
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, syncPromise);
	try {
		await syncPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

/** Notify the server a file was saved (content assumed already synced). */
export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	const info = client.openFiles.get(uri);
	if (!info) return;
	throwIfAborted(signal);
	await sendNotification(client, "textDocument/didSave", { textDocument: { uri } });
	client.lastActivity = Date.now();
}

/** Refresh a file: drop cached diagnostics, didChange + didSave from disk. */
export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) await untilAborted(signal, () => existingLock);

	const refreshPromise = (async () => {
		throwIfAborted(signal);
		client.diagnostics.delete(uri);
		const info = client.openFiles.get(uri);
		if (!info) {
			await ensureFileOpen(client, filePath, signal);
			return;
		}
		let content: string;
		try {
			content = await fs.readFile(filePath, "utf-8");
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const version = ++info.version;
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didChange", {
			textDocument: { uri, version },
			contentChanges: [{ text: content }],
		});
		throwIfAborted(signal);
		await sendNotification(client, "textDocument/didSave", { textDocument: { uri }, text: content });
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, refreshPromise);
	try {
		await refreshPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

async function waitForExit(client: LspClient, timeoutMs: number): Promise<boolean> {
	return Promise.race([
		waitForChildProcess(client.proc).then(
			() => true,
			() => true,
		),
		sleep(timeoutMs).then(() => false),
	]);
}

async function shutdownClientInstance(client: LspClient): Promise<void> {
	const err = new Error("LSP client shutdown");
	for (const pending of Array.from(client.pendingRequests.values())) pending.reject(err);
	client.pendingRequests.clear();

	const shutdownCompleted = await sendRequest(client, "shutdown", null, undefined, SHUTDOWN_TIMEOUT_MS).then(
		() => true,
		() => false,
	);
	if (shutdownCompleted) {
		await sendNotification(client, "exit", undefined).catch(() => {});
		if (await waitForExit(client, EXIT_TIMEOUT_MS)) return;
	}
	killClientProcess(client);
	await waitForExit(client, EXIT_TIMEOUT_MS);
}

function killClientProcess(client: LspClient): void {
	try {
		if (client.proc.pid) {
			// Surface the otherwise-silent forced kill of the LSP process tree.
			recordDiagnostic({
				category: "process.kill",
				level: "info",
				source: "lsp.dispose",
				context: { pid: client.proc.pid },
			});
			killProcessTree(client.proc.pid);
		} else client.proc.kill();
	} catch {
		try {
			client.proc.kill();
		} catch {
			// ignore
		}
	}
}

export async function shutdownClient(key: string): Promise<void> {
	const client = clients.get(key);
	if (!client) return;
	clients.delete(key);
	await shutdownClientInstance(client);
}

// =============================================================================
// LSP Protocol Methods
// =============================================================================

export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<unknown> {
	const id = ++client.requestId;
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new Error("aborted");
		return Promise.reject(reason);
	}

	const request: LspJsonRpcRequest = { jsonrpc: "2.0", id, method, params };
	client.lastActivity = Date.now();

	let resolve!: (value: unknown) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	let timeout: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (signal) signal.removeEventListener("abort", abortHandler);
	};
	const abortHandler = () => {
		if (client.pendingRequests.has(id)) client.pendingRequests.delete(id);
		void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
		if (timeout) clearTimeout(timeout);
		cleanup();
		const reason = signal?.reason instanceof Error ? signal.reason : new Error("aborted");
		reject(reason);
	};

	timeout = setTimeout(() => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
			cleanup();
			reject(new Error(`LSP request ${method} timed out after ${timeoutMs}ms`));
		}
	}, timeoutMs);

	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
		if (signal.aborted) {
			abortHandler();
			return promise;
		}
	}

	client.pendingRequests.set(id, {
		resolve: (result) => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			resolve(result);
		},
		reject: (err) => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			reject(err);
		},
		method,
	});

	queueWriteMessage(client, request).catch((err) => {
		if (timeout) clearTimeout(timeout);
		client.pendingRequests.delete(id);
		cleanup();
		reject(err);
	});
	return promise;
}

export async function sendNotification(client: LspClient, method: string, params: unknown): Promise<void> {
	const notification: LspJsonRpcNotification = { jsonrpc: "2.0", method, params };
	client.lastActivity = Date.now();
	await queueWriteMessage(client, notification);
}

/** Kill a client's process directly (used by `reload` cold-restart). */
export function killClient(client: LspClient): void {
	killClientProcess(client);
}

export async function shutdownAll(): Promise<void> {
	const clientsToShutdown = Array.from(clients.values());
	clients.clear();
	await Promise.allSettled(clientsToShutdown.map((client) => shutdownClientInstance(client)));
}

/** Shut down only the clients rooted at a given cwd. */
export async function shutdownClientsForCwd(cwd: string): Promise<void> {
	const targets = Array.from(clients.entries()).filter(([, client]) => client.cwd === cwd);
	for (const [key] of targets) clients.delete(key);
	await Promise.allSettled(targets.map(([, client]) => shutdownClientInstance(client)));
}
