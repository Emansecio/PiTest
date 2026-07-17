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
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { killProcessTree } from "../../utils/shell.ts";
import { truncateWithEllipsis } from "../../utils/surrogate.ts";
import { LruMap } from "../lru-map.ts";
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
import { canonicalUriKey, detectLanguageId, fileToUri, uriToFile } from "./utils.ts";

/** Cap retained open documents per LSP client (LRU eviction via closeFile). */
export const OPEN_FILES_LRU_CAP = 64;

// =============================================================================
// Client State
// =============================================================================

const clients = new Map<string, LspClient>();
const clientLocks = new Map<string, Promise<LspClient>>();
const fileOperationLocks = new Map<string, Promise<void>>();

// =============================================================================
// Boot-failure circuit breaker
// =============================================================================

// A language server that fails to spawn/initialize (missing binary, crash on
// initialize, hang past the init timeout) has no failure memory in the base
// design: every direct caller (writethrough, tool-actions, grounding-guard)
// re-spawns from scratch, re-paying the full spawn + init-timeout cost on each
// edit/tool call. This map remembers a genuine boot failure per client key so
// that, while within a cooldown window, getOrCreateClient throws immediately
// (cheap, no spawn) instead of re-spawning. After the window elapses one retry
// is allowed; a repeat failure re-arms the cooldown.
interface LspBootFailure {
	failedAt: number;
	reason: string;
}
const lspBootFailures = new Map<string, LspBootFailure>();

/** Default cooldown after a boot failure before a single re-spawn is allowed. */
const DEFAULT_BOOT_BREAKER_COOLDOWN_MS = 60_000;

/** PIT_NO_LSP_BOOT_BREAKER=1 disables the breaker (always re-spawn, legacy behavior). */
function bootBreakerDisabled(): boolean {
	return isTruthyEnvFlag(process.env.PIT_NO_LSP_BOOT_BREAKER);
}

/** Cooldown window in ms; test/tuning override via PIT_LSP_BOOT_BREAKER_COOLDOWN_MS. */
function bootBreakerCooldownMs(): number {
	const raw = process.env.PIT_LSP_BOOT_BREAKER_COOLDOWN_MS;
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
	}
	return DEFAULT_BOOT_BREAKER_COOLDOWN_MS;
}

/** True when a rejection was caused by an abort (user ESC / AbortSignal), not a genuine boot failure. */
function isAbortRejection(err: unknown): boolean {
	if (err instanceof Error) {
		return err.name === "AbortError" || err.message === "aborted";
	}
	return false;
}

function bootFailureReason(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return truncateWithEllipsis(message, 300);
}

/** Drop all remembered boot failures (config reload / dispose). */
export function clearLspBootFailureMemory(): void {
	lspBootFailures.clear();
}

/** Test-only reset for the boot-failure circuit breaker. */
export function _resetLspFailureMemoryForTest(): void {
	lspBootFailures.clear();
}

// Best-effort safety net: if the host exits without a graceful session dispose,
// don't leak language-server processes. Registered lazily on first client.
let exitHookRegistered = false;
function registerExitHook(): void {
	if (exitHookRegistered) return;
	exitHookRegistered = true;
	process.on("exit", () => {
		for (const client of clients.values()) {
			try {
				// Script launchers spawn through a cmd.exe shell wrapper on Windows
				// (shell:true), so client.proc is the wrapper, not the real LSP
				// server. Reap the whole tree like killClientProcess does, falling
				// back to a direct kill only when there's no pid.
				if (client.proc.pid) killProcessTree(client.proc.pid);
				else client.proc.kill();
			} catch {
				try {
					client.proc.kill();
				} catch {
					// ignore
				}
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

export async function routeMessage(
	client: LspClient,
	message: LspJsonRpcResponse | LspJsonRpcNotification,
): Promise<void> {
	// Discriminate by `method`, NOT by id lookup. A server-initiated REQUEST
	// carries both `method` and `id`; its id comes from the server's own counter
	// and can collide with one of our in-flight outbound request ids. Looking up
	// pendingRequests first would resolve our own promise with the request's
	// (absent) result and never answer the server. So: any message with a
	// `method` is a server request (has id) or a notification (no id); only a
	// message WITHOUT a method is a response to one of our outbound requests.
	if ("method" in message) {
		if ("id" in message && message.id !== undefined && message.id !== null) {
			await handleServerRequest(client, message as unknown as LspJsonRpcRequest);
			return;
		}
		const notification = message as LspJsonRpcNotification;
		if (notification.method === "textDocument/publishDiagnostics" && notification.params) {
			const params = notification.params as PublishDiagnosticsParams;
			// Store under the canonical URI key: every lookup (waitForDiagnostics,
			// code_actions context, writethrough) queries with fileToUri output, and
			// a server that re-normalizes URIs (lowercase drive / %3A on Windows)
			// would otherwise publish under a key no lookup ever hits.
			client.diagnostics.set(canonicalUriKey(params.uri), {
				diagnostics: params.diagnostics,
				version: params.version ?? null,
			});
			client.diagnosticsVersion += 1;
		} else if (notification.method === "$/progress" && notification.params) {
			const params = notification.params as { token: string | number; value?: { kind?: string } };
			if (params.value?.kind === "begin") {
				client.activeProgressTokens.add(params.token);
			} else if (params.value?.kind === "end") {
				// Only resolve when an actually-tracked token ends and none remain.
				// A spurious 'end' for a token we never saw 'begin' for (delete=false)
				// must NOT resolve projectLoaded prematurely.
				const wasActive = client.activeProgressTokens.delete(params.token);
				if (wasActive && client.activeProgressTokens.size === 0) client.resolveProjectLoaded();
			}
		}
		return;
	}
	if ("id" in message && message.id !== undefined) {
		const pending = client.pendingRequests.get(message.id as number);
		if (pending) {
			client.pendingRequests.delete(message.id as number);
			if ("error" in message && message.error) {
				pending.reject(new Error(`LSP error: ${message.error.message}`));
			} else {
				pending.resolve(message.result);
			}
		}
	}
}

async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.id === undefined || message.id === null) return;
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map((item) => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? {};
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.id === undefined || message.id === null) return;
	if ((client.serverApplyEditDepth ?? 0) <= 0) {
		await sendResponse(
			client,
			message.id,
			{
				applied: false,
				failureReason: "workspace/applyEdit is only allowed during an explicit LSP apply operation",
			},
			"workspace/applyEdit",
		);
		return;
	}
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
		if (message.id !== undefined && message.id !== null) {
			await sendResponse(client, message.id, null, message.method);
		}
		return;
	}
	if (message.id === undefined || message.id === null) return;
	await sendResponse(client, message.id, null, message.method, {
		code: -32601,
		message: `Method not found: ${message.method}`,
	});
}

async function sendResponse(
	client: LspClient,
	id: number | string,
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

export async function getOrCreateClient(
	config: ServerConfig,
	cwd: string,
	initTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<LspClient> {
	registerExitHook();
	// Key by what actually distinguishes the process, not just the raw command
	// name. Two configs can share a command (e.g. one server and one linter both
	// invoking the same binary) yet differ in resolvedCommand/args/initOptions;
	// keying on `command` alone would make the second caller reuse the first
	// server via the clients.get fast-path, yielding wrong diagnostics/caps.
	const keyCommand = config.resolvedCommand ?? config.command;
	const key = `${keyCommand}:${JSON.stringify(config.args ?? [])}:${JSON.stringify(config.initOptions ?? {})}:${cwd}`;

	const existingClient = clients.get(key);
	if (existingClient) {
		existingClient.lastActivity = Date.now();
		return existingClient;
	}
	const existingLock = clientLocks.get(key);
	if (existingLock) return existingLock;

	// Boot-failure circuit breaker: a recent genuine spawn/init failure for this
	// exact key short-circuits here — no process spawn, no init-timeout wait —
	// until the cooldown elapses. One retry is then allowed (delete now); a repeat
	// failure re-arms the cooldown in the catch below.
	if (!bootBreakerDisabled()) {
		const failure = lspBootFailures.get(key);
		if (failure) {
			if (Date.now() - failure.failedAt < bootBreakerCooldownMs()) {
				throw new Error(`LSP server "${keyCommand}" cooling down after boot failure: ${failure.reason}`);
			}
			lspBootFailures.delete(key);
		}
	}

	// Assigned right after the IIFE below is created; the ownership guards inside
	// (onExit / catch / finally) only run after real async work, so they always
	// observe the assigned value. A `let` (not a direct clientPromise reference)
	// avoids a TDZ ReferenceError if anything before the first await throws
	// synchronously.
	let selfLock: Promise<LspClient> | undefined;
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
			openFiles: new LruMap(OPEN_FILES_LRU_CAP),
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
			serverApplyEditDepth: 0,
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
			// Only drop registry entries that still belong to THIS client. A stale
			// exit (a crash landing after this client was already shut down and a
			// replacement began warming under the same key) must not evict the newer
			// client or its in-flight warmup lock — that would let a third caller
			// spawn a duplicate server and leak the replacement.
			if (clients.get(key) === client) clients.delete(key);
			if (clientLocks.get(key) === selfLock) clientLocks.delete(key);
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
				signal,
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
			// Same ownership guard as onExit: never evict a newer client/lock that
			// replaced this failed attempt under the same key.
			if (clients.get(key) === client) clients.delete(key);
			killClientProcess(client);
			// Arm the circuit breaker on a GENUINE spawn/init failure only. An abort
			// (user ESC / caller AbortSignal) is not a server fault, so it must not
			// suppress the next legitimate spawn.
			if (!bootBreakerDisabled() && !signal?.aborted && !isAbortRejection(err)) {
				lspBootFailures.set(key, { failedAt: Date.now(), reason: bootFailureReason(err) });
			}
			throw err;
		} finally {
			if (clientLocks.get(key) === selfLock) clientLocks.delete(key);
		}
	})();

	// Bind the ownership token now that the promise exists (see the `let selfLock`
	// note above). Without this, the onExit/catch/finally guards compare against
	// `undefined` and never match, so `clientLocks` entries are never cleaned up —
	// a leak that makes later shutdownAll/shutdownClientsForCwd calls resolve stale
	// locks to already-dead processes and pay the full shutdown+exit timeout on each.
	selfLock = clientPromise;
	clientLocks.set(key, clientPromise);
	return clientPromise;
}

export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	// Touch LRU recency when already open.
	if (client.openFiles.get(uri)) return;

	// Atomically chain onto any in-flight op for this uri so concurrent callers
	// serialize on one promise chain. Acquisition (read prev + set op) must be
	// synchronous with no `await` between, or a second caller could read the same
	// prev and clobber the lock (TOCTOU).
	const prev = fileOperationLocks.get(lockKey) ?? Promise.resolve();
	const op = prev
		.catch(() => {})
		.then(async () => {
			// Signal-unaware body: it runs to completion for whoever chained it so
			// later callers in the chain observe a consistent server state. Each
			// caller aborts its own *wait* via untilAborted below.
			if (client.openFiles.get(uri)) return;
			await evictOpenFilesIfNeeded(client, uri);
			let content: string;
			try {
				content = await fs.readFile(filePath, "utf-8");
			} catch (err) {
				if (isEnoent(err)) return;
				throw err;
			}
			const languageId = detectLanguageId(filePath);
			await sendNotification(client, "textDocument/didOpen", {
				textDocument: { uri, languageId, version: 1, text: content },
			});
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
		});

	fileOperationLocks.set(lockKey, op);
	try {
		await untilAborted(signal, () => op);
	} finally {
		// Only clear the lock if it's still ours; a later caller may have already
		// chained its own op and replaced the map entry.
		if (fileOperationLocks.get(lockKey) === op) fileOperationLocks.delete(lockKey);
	}
}

/**
 * Close a document on the server: didClose + drop openFiles/diagnostics entries.
 * Serialized via fileOperationLocks (same as ensureFileOpen / syncContent).
 */
export async function closeFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	if (!client.openFiles.has(uri)) {
		client.diagnostics.delete(uri);
		return;
	}

	const prev = fileOperationLocks.get(lockKey) ?? Promise.resolve();
	const op = prev
		.catch(() => {})
		.then(async () => {
			if (!client.openFiles.has(uri)) {
				client.diagnostics.delete(uri);
				return;
			}
			try {
				await sendNotification(client, "textDocument/didClose", { textDocument: { uri } });
			} finally {
				// Always drop local state so LRU eviction cannot spin if didClose fails.
				client.openFiles.delete(uri);
				client.diagnostics.delete(uri);
				client.lastActivity = Date.now();
			}
		});

	fileOperationLocks.set(lockKey, op);
	try {
		await untilAborted(signal, () => op);
	} finally {
		if (fileOperationLocks.get(lockKey) === op) fileOperationLocks.delete(lockKey);
	}
}

/** Evict least-recently-used open docs until under the LRU cap (excluding `keepUri`). */
async function evictOpenFilesIfNeeded(client: LspClient, keepUri: string): Promise<void> {
	while (client.openFiles.size >= OPEN_FILES_LRU_CAP) {
		const oldest = client.openFiles.peekOldestKey();
		if (oldest === undefined) break;
		if (oldest === keepUri) {
			// Only the keep uri remains at/over cap — nothing safe to evict.
			break;
		}
		await closeFile(client, uriToFile(oldest));
	}
}

/**
 * Wait for the server's initial project loading to complete. Races the server's
 * $/progress tracking against the abort signal; returns immediately if already
 * complete or timed out.
 */
export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	if (!signal) {
		await client.projectLoaded;
		return;
	}
	// Always remove the abort listener after the race. `{ once: true }` only
	// removes it when 'abort' actually fires; in the common case projectLoaded
	// wins and the listener would otherwise stay attached to a long-lived caller
	// signal, accumulating across retries (MaxListenersExceededWarning).
	let onAbort: (() => void) | undefined;
	try {
		await Promise.race([
			client.projectLoaded,
			new Promise<void>((resolve) => {
				onAbort = () => resolve();
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
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

	// Atomically chain onto any in-flight op for this uri (see ensureFileOpen):
	// read prev + set op with no `await` between, so concurrent same-uri callers
	// serialize and the version bump / didChange order can't interleave.
	const prev = fileOperationLocks.get(lockKey) ?? Promise.resolve();
	const op = prev
		.catch(() => {})
		.then(async () => {
			client.diagnostics.delete(uri);
			const info = client.openFiles.get(uri);
			if (!info) {
				await evictOpenFilesIfNeeded(client, uri);
				const languageId = detectLanguageId(filePath);
				await sendNotification(client, "textDocument/didOpen", {
					textDocument: { uri, languageId, version: 1, text: content },
				});
				client.openFiles.set(uri, { version: 1, languageId });
				client.lastActivity = Date.now();
				return;
			}
			const version = ++info.version;
			await sendNotification(client, "textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
			client.lastActivity = Date.now();
		});

	fileOperationLocks.set(lockKey, op);
	try {
		await untilAborted(signal, () => op);
	} finally {
		if (fileOperationLocks.get(lockKey) === op) fileOperationLocks.delete(lockKey);
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
	// Atomically chain onto any in-flight op for this uri (see ensureFileOpen):
	// read prev + set op with no `await` between. The open-from-scratch path is
	// inlined rather than delegating to ensureFileOpen, because ensureFileOpen
	// would chain onto *this* op as its prev and await it — a self-deadlock.
	const prev = fileOperationLocks.get(lockKey) ?? Promise.resolve();
	const op = prev
		.catch(() => {})
		.then(async () => {
			client.diagnostics.delete(uri);
			const info = client.openFiles.get(uri);
			if (!info) {
				let openText: string;
				try {
					openText = await fs.readFile(filePath, "utf-8");
				} catch (err) {
					if (isEnoent(err)) return;
					throw err;
				}
				await evictOpenFilesIfNeeded(client, uri);
				const languageId = detectLanguageId(filePath);
				await sendNotification(client, "textDocument/didOpen", {
					textDocument: { uri, languageId, version: 1, text: openText },
				});
				client.openFiles.set(uri, { version: 1, languageId });
				client.lastActivity = Date.now();
				return;
			}
			let content: string;
			try {
				content = await fs.readFile(filePath, "utf-8");
			} catch (err) {
				if (isEnoent(err)) return;
				throw err;
			}
			const version = ++info.version;
			await sendNotification(client, "textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
			await sendNotification(client, "textDocument/didSave", { textDocument: { uri }, text: content });
			client.lastActivity = Date.now();
		});

	fileOperationLocks.set(lockKey, op);
	try {
		await untilAborted(signal, () => op);
	} finally {
		if (fileOperationLocks.get(lockKey) === op) fileOperationLocks.delete(lockKey);
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

/**
 * Resolve a possibly-in-flight client for `key`. A client warming up lives only
 * in `clientLocks` (it is published to `clients` only after initialize+initialized
 * complete, line ~505). Awaiting the lock lets shutdown reach a server that is
 * still mid-handshake instead of leaking it (the lock would otherwise resolve
 * AFTER dispose and re-register an orphaned client). Init failures already clean
 * up `clients`/`clientLocks` and kill the proc, so a rejected lock is benign.
 */
async function resolvePendingClient(key: string): Promise<LspClient | undefined> {
	const lock = clientLocks.get(key);
	if (!lock) return undefined;
	return lock.then(
		(client) => client,
		() => undefined,
	);
}

export async function shutdownClient(key: string): Promise<void> {
	const client = clients.get(key) ?? (await resolvePendingClient(key));
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
			void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
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

export async function withServerApplyEdit<T>(client: LspClient, operation: () => Promise<T>): Promise<T> {
	client.serverApplyEditDepth += 1;
	try {
		return await operation();
	} finally {
		client.serverApplyEditDepth -= 1;
	}
}

/** Kill a client's process directly (used by `reload` cold-restart). */
export function killClient(client: LspClient): void {
	killClientProcess(client);
}

export async function shutdownAll(): Promise<void> {
	// Drain in-flight warmups too: a client still mid-initialize lives only in
	// clientLocks (not `clients` yet), so a snapshot of `clients` alone would let
	// the racing server re-register after shutdown and leak.
	const pendingKeys = Array.from(clientLocks.keys());
	const pending = await Promise.all(pendingKeys.map((key) => resolvePendingClient(key)));
	const clientsToShutdown = new Set<LspClient>(clients.values());
	for (const client of pending) {
		if (client) clientsToShutdown.add(client);
	}
	clients.clear();
	await Promise.allSettled(Array.from(clientsToShutdown).map((client) => shutdownClientInstance(client)));
}

/** Shut down only the clients rooted at a given cwd. */
export async function shutdownClientsForCwd(cwd: string): Promise<void> {
	// Resolve any in-flight warmups first so a server still mid-handshake for this
	// cwd is torn down rather than re-registering after dispose (the lock key is
	// `${command}:${cwd}` and resolves to a client whose .cwd === cwd).
	const pendingKeys = Array.from(clientLocks.keys()).filter((key) => key.endsWith(`:${cwd}`));
	const pending = await Promise.all(pendingKeys.map((key) => resolvePendingClient(key)));
	const targets = new Set<LspClient>();
	for (const [key, client] of clients.entries()) {
		if (client.cwd === cwd) {
			targets.add(client);
			clients.delete(key);
		}
	}
	for (const client of pending) {
		if (client && client.cwd === cwd) {
			targets.add(client);
			clients.delete(client.name);
		}
	}
	await Promise.allSettled(Array.from(targets).map((client) => shutdownClientInstance(client)));
}
