import type * as NodeOs from "node:os";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseInput,
	ResponseStreamEvent,
} from "openai/resources/responses/responses.js";

// NEVER convert to top-level runtime imports - breaks browser/Vite builds
let _os: typeof NodeOs | null = null;

type DynamicImport = (specifier: string) => Promise<unknown>;

const dynamicImport: DynamicImport = (specifier) => import(specifier);
const NODE_OS_SPECIFIER = "node:" + "os";

if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	dynamicImport(NODE_OS_SPECIFIER).then((m) => {
		_os = m as typeof NodeOs;
	});
}

import { getEnvApiKey } from "../env-api-keys.ts";
import { clampThinkingLevel } from "../models.ts";
import { registerSessionResourceCleanup } from "../session-resources.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
	StreamFunction,
	StreamOptions,
} from "../types.ts";
import { type ConnectGuard, createConnectGuard, DEFAULT_CONNECT_TIMEOUT_MS } from "../utils/connect-guard.ts";
import {
	appendAssistantMessageDiagnostic,
	createAssistantMessageDiagnostic,
	formatThrownValue,
} from "../utils/diagnostics.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { headersToRecord } from "../utils/headers.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, IdleStreamTimeoutError, raceReadWithIdle } from "../utils/idle-timeout.ts";
import { computeRetryDelay, isRetryableStatus, parseRetryAfter } from "../utils/retry-headers.ts";
import { recordDiagnostic } from "../utils/runtime-diagnostics.ts";
import { SseChunkBuffer } from "../utils/sse-chunk-reader.ts";
import { resolveStreamTimeouts } from "../utils/stream-timeouts.ts";
import { buildToolNameGuard, NOOP_TOOL_NAME_GUARD, type ToolNameGuard } from "../utils/tool-name-guard.ts";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.ts";
import {
	applyDynamicPromptRelocation,
	applyServiceTierPricing,
	convertResponsesMessages,
	convertResponsesTools,
	createInitialAssistantMessage,
	processResponsesStream,
	RESPONSES_TOOL_CALL_PROVIDERS,
	stripStreamingScratch,
} from "./openai-responses-shared.ts";
import { buildBaseOptions } from "./simple-options.ts";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const JWT_CLAIM_PATH = "https://api.openai.com/auth" as const;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE = 1009;

const CODEX_RESPONSE_STATUSES = new Set<CodexResponseStatus>([
	"completed",
	"incomplete",
	"failed",
	"cancelled",
	"queued",
	"in_progress",
]);

// ============================================================================
// Types
// ============================================================================

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
	reasoningSummary?: "auto" | "concise" | "detailed" | "off" | "on" | null;
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	textVerbosity?: "low" | "medium" | "high";
}

type CodexResponseStatus = "completed" | "incomplete" | "failed" | "cancelled" | "queued" | "in_progress";

interface RequestBody {
	model: string;
	store?: boolean;
	stream?: boolean;
	instructions?: string;
	previous_response_id?: string;
	input?: ResponseInput;
	tools?: OpenAITool[];
	tool_choice?: "auto";
	parallel_tool_calls?: boolean;
	temperature?: number;
	reasoning?: { effort?: string; summary?: string };
	service_tier?: ResponseCreateParamsStreaming["service_tier"];
	text?: { verbosity?: string };
	include?: string[];
	prompt_cache_key?: string;
	[key: string]: unknown;
}

// ============================================================================
// Retry Helpers
// ============================================================================

function isRetryableError(status: number, errorText: string): boolean {
	if (isRetryableStatus(status)) {
		return true;
	}
	return /rate.?limit|overloaded|service.?unavailable|upstream.?connect|connection.?refused/i.test(errorText);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("Request was aborted"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Request was aborted"));
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

// ============================================================================
// Main Stream Function
// ============================================================================

export const streamOpenAICodexResponses: StreamFunction<"openai-codex-responses", OpenAICodexResponsesOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = createInitialAssistantMessage(model, "openai-codex-responses" as Api);

		try {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider) || "";
			if (!apiKey) {
				throw new Error(`No API key for provider: ${model.provider}`);
			}

			const accountId = extractAccountId(apiKey);
			const toolNameGuard = buildToolNameGuard(context.tools);
			let body = buildRequestBody(model, context, options, toolNameGuard);
			const nextBody = await options?.onPayload?.(body, model);
			if (nextBody !== undefined) {
				body = nextBody as RequestBody;
			}
			const websocketRequestId = options?.sessionId || createCodexRequestId();
			const sseHeaders = buildSSEHeaders(model.headers, options?.headers, accountId, apiKey, options?.sessionId);
			const websocketHeaders = buildWebSocketHeaders(
				model.headers,
				options?.headers,
				accountId,
				apiKey,
				websocketRequestId,
			);
			// Lazy body serialization: the default (happy) WebSocket path never needs
			// the JSON string — it was ~1.2ms/turn of dead JSON.stringify at 500KB of
			// context. Serialize once, on first use (SSE fetch path or the WS-failure
			// diagnostic), and memoize for the SSE retry loop.
			let bodyJsonCache: string | undefined;
			const getBodyJson = () => {
				bodyJsonCache ??= JSON.stringify(body);
				return bodyJsonCache;
			};
			const transport = options?.transport || "auto";
			const websocketDisabledForSession = transport !== "sse" && isWebSocketSseFallbackActive(options?.sessionId);
			if (websocketDisabledForSession) {
				recordWebSocketSseFallback(options?.sessionId);
			}

			if (transport !== "sse" && !websocketDisabledForSession) {
				let websocketStarted = false;
				try {
					await processWebSocketStream(
						resolveCodexWebSocketUrl(model.baseUrl),
						body,
						websocketHeaders,
						output,
						stream,
						model,
						() => {
							websocketStarted = true;
						},
						options,
						toolNameGuard,
					);

					if (options?.signal?.aborted) {
						throw new Error("Request was aborted");
					}
					stream.push({
						type: "done",
						reason: output.stopReason as "stop" | "length" | "toolUse",
						message: output,
					});
					stream.end();
					return;
				} catch (error) {
					const aborted = options?.signal?.aborted;
					if (aborted || isCodexNonTransportError(error)) {
						throw error;
					}
					appendAssistantMessageDiagnostic(
						output,
						createAssistantMessageDiagnostic("provider_transport_failure", error, {
							configuredTransport: transport,
							fallbackTransport: websocketStarted ? undefined : "sse",
							eventsEmitted: websocketStarted,
							phase: websocketStarted ? "after_message_stream_start" : "before_message_stream_start",
							requestBytes: new TextEncoder().encode(getBodyJson()).byteLength,
						}),
					);
					recordWebSocketFailure(options?.sessionId, error);
					if (websocketStarted) {
						throw error;
					}
					recordWebSocketSseFallback(options?.sessionId);
				}
			}

			// Fetch with retry logic for rate limits and transient errors.
			// Honor caller-provided maxRetries/timeoutMs (StreamOptions) like the
			// Anthropic/OpenAI providers do; fall back to the Codex defaults when
			// unset. maxRetries=0 means a single attempt (no retries), not an
			// infinite loop — Math.max(0, ...) guards against negative input.
			const maxRetries = Math.max(0, options?.maxRetries ?? MAX_RETRIES);
			const timeouts = resolveStreamTimeouts(options);
			let response: Response | undefined;
			let lastError: Error | undefined;

			for (let attempt = 0; attempt <= maxRetries; attempt++) {
				if (options?.signal?.aborted) {
					throw new Error("Request was aborted");
				}

				let attemptGuard: ConnectGuard | undefined;
				try {
					attemptGuard = createConnectGuard(options?.signal, timeouts.connectTimeoutMs);
					response = await attemptGuard.settle(
						fetch(resolveCodexUrl(model.baseUrl), {
							method: "POST",
							headers: sseHeaders,
							body: getBodyJson(),
							signal: attemptGuard.signal,
						}),
					);
					await options?.onResponse?.(
						{ status: response.status, headers: headersToRecord(response.headers) },
						model,
					);

					if (response.ok) {
						break;
					}

					const errorText = await response.text();
					if (attempt < maxRetries && isRetryableError(response.status, errorText)) {
						// Honor the server's requested retry-after verbatim when present;
						// otherwise jitter an exponential backoff to avoid a thundering-herd
						// retry storm against the provider.
						const retryAfterMs = parseRetryAfter(response.headers);
						const delayMs = computeRetryDelay(attempt, retryAfterMs, { baseDelayMs: BASE_DELAY_MS });

						await sleep(delayMs, options?.signal);
						continue;
					}

					// Parse error for friendly message on final attempt or non-retryable error
					const fakeResponse = new Response(errorText, {
						status: response.status,
						statusText: response.statusText,
					});
					const info = await parseErrorResponse(fakeResponse);
					throw new Error(info.friendlyMessage || info.message);
				} catch (error) {
					// A user abort (not a per-attempt connect-timeout) is terminal: surface
					// it immediately. A connect-timeout aborts only this attempt's controller,
					// so options.signal stays un-aborted and the error falls through to retry.
					const userAborted = options?.signal?.aborted === true;
					if (userAborted && error instanceof Error) {
						if (error.name === "AbortError" || error.message === "Request was aborted") {
							throw new Error("Request was aborted");
						}
					}
					lastError = error instanceof Error ? error : new Error(String(error));
					// Network errors (including a per-attempt connect-timeout) are retryable
					if (attempt < maxRetries && !lastError.message.includes("usage limit")) {
						const delayMs = computeRetryDelay(attempt, null, { baseDelayMs: BASE_DELAY_MS });
						await sleep(delayMs, options?.signal);
						continue;
					}
					throw lastError;
				} finally {
					attemptGuard?.dispose();
				}
			}

			if (!response?.ok) {
				throw lastError ?? new Error("Failed after retries");
			}

			if (!response.body) {
				throw new Error("No response body");
			}

			stream.push({ type: "start", partial: output });
			await processStream(response, output, stream, model, options, toolNameGuard);

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				stripStreamingScratch(block);
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

export const streamSimpleOpenAICodexResponses: StreamFunction<"openai-codex-responses", SimpleStreamOptions> = (
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	const apiKey = options?.apiKey || getEnvApiKey(model.provider);
	if (!apiKey) {
		throw new Error(`No API key for provider: ${model.provider}`);
	}

	const base = buildBaseOptions(model, options, apiKey);
	const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;

	return streamOpenAICodexResponses(model, context, {
		...base,
		reasoningEffort,
	} satisfies OpenAICodexResponsesOptions);
};

// ============================================================================
// Request Building
// ============================================================================

/**
 * Codex backend rejects "minimal" effort on the gpt-5.2+ series and the
 * gpt-5.1-codex-mini variant. Clamp to a safe, model-appropriate value before
 * sending so we don't return server-side errors for valid client requests.
 */
function clampReasoningEffort(modelId: string, effort: string): string {
	const id = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
	if (
		(id.startsWith("gpt-5.2") ||
			id.startsWith("gpt-5.3") ||
			id.startsWith("gpt-5.4") ||
			id.startsWith("gpt-5.5") ||
			id.startsWith("gpt-5.6")) &&
		effort === "minimal"
	) {
		return "low";
	}
	if (id === "gpt-5.1" && effort === "xhigh") return "high";
	if (id === "gpt-5.1-codex-mini") return effort === "high" || effort === "xhigh" ? "high" : "medium";
	return effort;
}

function buildRequestBody(
	model: Model<"openai-codex-responses">,
	context: Context,
	options?: OpenAICodexResponsesOptions,
	toolNameGuard: ToolNameGuard = NOOP_TOOL_NAME_GUARD,
): RequestBody {
	const messages = convertResponsesMessages(
		model,
		context,
		RESPONSES_TOOL_CALL_PROVIDERS,
		{
			includeSystemPrompt: false,
		},
		toolNameGuard,
	);
	// `instructions` is the first segment of the automatically cached prompt
	// prefix, so it must stay byte-stable across turns; the per-turn dynamic
	// suffix rides the newest user message as an <env> block instead (M1).
	// Websocket-cached transport note: the env block moves between turns, so the
	// client-side delta continuation falls back to a full-context send (input
	// prefix mismatch in getCachedWebSocketInputDelta) — the same fallback that
	// already fired when the churning `instructions` broke
	// requestBodiesMatchExceptInput — but the server-side prefix cache now
	// covers instructions + replayed history instead of missing at position 0.
	const { systemPromptText } = applyDynamicPromptRelocation(messages, context.systemPrompt);

	const body: RequestBody = {
		model: model.id,
		store: false,
		stream: true,
		instructions: systemPromptText ?? "You are a helpful assistant.",
		input: messages,
		text: { verbosity: options?.textVerbosity || "low" },
		include: ["reasoning.encrypted_content"],
		prompt_cache_key: clampOpenAIPromptCacheKey(options?.sessionId),
		tool_choice: "auto",
		parallel_tool_calls: true,
	};

	if (options?.temperature !== undefined) {
		body.temperature = options.temperature;
	}

	if (options?.serviceTier !== undefined) {
		body.service_tier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0) {
		body.tools = convertResponsesTools(context.tools, { strict: null }, toolNameGuard);
	}

	if (options?.reasoningEffort !== undefined) {
		const mapped =
			options.reasoningEffort === "none"
				? (model.thinkingLevelMap?.off ?? "none")
				: (model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort);
		const effort = mapped !== null ? clampReasoningEffort(model.id, String(mapped)) : null;
		if (effort !== null) {
			body.reasoning = {
				effort,
				summary: options.reasoningSummary ?? "auto",
			};
		}
	}

	return body;
}

function resolveCodexServiceTier(
	responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): ResponseCreateParamsStreaming["service_tier"] | undefined {
	if (responseServiceTier === "default" && (requestServiceTier === "flex" || requestServiceTier === "priority")) {
		return requestServiceTier;
	}
	return responseServiceTier ?? requestServiceTier;
}

function resolveCodexUrl(baseUrl?: string): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_CODEX_BASE_URL;
	const normalized = raw.replace(/\/+$/, "");
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

function resolveCodexWebSocketUrl(baseUrl?: string): string {
	const url = new URL(resolveCodexUrl(baseUrl));
	if (url.protocol === "https:") url.protocol = "wss:";
	if (url.protocol === "http:") url.protocol = "ws:";
	return url.toString();
}

// ============================================================================
// Response Processing
// ============================================================================

async function processStream(
	response: Response,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	options?: OpenAICodexResponsesOptions,
	toolNameGuard: ToolNameGuard = NOOP_TOOL_NAME_GUARD,
): Promise<void> {
	await processResponsesStream(
		mapCodexEvents(parseSSE(response, options?.signal, options?.idleTimeoutMs)),
		output,
		stream,
		model,
		{
			toolNameGuard,
			serviceTier: options?.serviceTier,
			resolveServiceTier: resolveCodexServiceTier,
			applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
		},
	);
}

class CodexApiError extends Error {
	readonly code?: string;
	readonly payload?: Record<string, unknown>;

	constructor(message: string, options?: { code?: string; payload?: Record<string, unknown>; cause?: unknown }) {
		super(message);
		this.name = "CodexApiError";
		this.code = options?.code;
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

class CodexProtocolError extends Error {
	readonly payload?: unknown;

	constructor(message: string, options?: { payload?: unknown; cause?: unknown }) {
		super(message);
		this.name = "CodexProtocolError";
		this.payload = options?.payload;
		this.cause = options?.cause;
	}
}

function isCodexNonTransportError(error: unknown): boolean {
	return error instanceof CodexApiError || error instanceof CodexProtocolError;
}

async function* mapCodexEvents(events: AsyncIterable<Record<string, unknown>>): AsyncGenerator<ResponseStreamEvent> {
	for await (const event of events) {
		const type = typeof event.type === "string" ? event.type : undefined;
		if (!type) continue;

		if (type === "error") {
			const code = (event as { code?: string }).code || "";
			const message = (event as { message?: string }).message || "";
			throw new CodexApiError(`Codex error: ${message || code || JSON.stringify(event)}`, {
				code: code || undefined,
				payload: event,
			});
		}

		if (type === "response.failed") {
			const response = (event as { response?: { error?: { code?: string; message?: string } } }).response;
			const code = response?.error?.code;
			const message = response?.error?.message;
			throw new CodexApiError(message || "Codex response failed", { code, payload: event });
		}

		if (type === "response.done" || type === "response.completed" || type === "response.incomplete") {
			const response = (event as { response?: { status?: unknown } }).response;
			const normalizedResponse = response
				? { ...response, status: normalizeCodexStatus(response.status) }
				: response;
			yield { ...event, type: "response.completed", response: normalizedResponse } as ResponseStreamEvent;
			return;
		}

		yield event as unknown as ResponseStreamEvent;
	}
}

function normalizeCodexStatus(status: unknown): CodexResponseStatus | undefined {
	if (typeof status !== "string") return undefined;
	return CODEX_RESPONSE_STATUSES.has(status as CodexResponseStatus) ? (status as CodexResponseStatus) : undefined;
}

// ============================================================================
// SSE Parsing
// ============================================================================

async function* parseSSE(
	response: Response,
	signal?: AbortSignal,
	idleMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): AsyncGenerator<Record<string, unknown>> {
	if (!response.body) return;

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks = new SseChunkBuffer();

	try {
		while (true) {
			// Idle watchdog: guard against a half-open socket stalling the body
			// read forever. User abort propagates as before via `signal`.
			const { done, value } = await raceReadWithIdle(reader, { idleMs, signal });
			if (done) break;
			chunks.append(decoder.decode(value, { stream: true }));

			// Cursor-based scan: advance through buffer without rewriting it on each
			// chunk boundary. Compact only when prefix grows past the threshold.
			let idx = chunks.findFromCursor("\n\n");
			while (idx !== -1) {
				const chunk = chunks.sliceFromCursor(idx);
				chunks.advanceTo(idx + 2);

				// Single-pass line scan over `chunk` (avoids split/filter/map
				// allocating intermediate arrays + closures per delta). Same
				// predicate/slice/trim as before: data: prefix → slice(5).trim().
				const dataLines: string[] = [];
				let lineStart = 0;
				while (lineStart <= chunk.length) {
					let nl = chunk.indexOf("\n", lineStart);
					if (nl === -1) nl = chunk.length;
					const line = chunk.slice(lineStart, nl);
					if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
					lineStart = nl + 1;
				}
				if (dataLines.length > 0) {
					const data = dataLines.join("\n").trim();
					if (data && data !== "[DONE]") {
						try {
							yield JSON.parse(data) as Record<string, unknown>;
						} catch (cause) {
							throw new CodexProtocolError(`Invalid Codex SSE JSON: ${formatThrownValue(cause)}`, {
								cause,
								payload: data,
							});
						}
					}
				}
				idx = chunks.findFromCursor("\n\n");
			}

			chunks.compactIfNeeded();
		}
	} finally {
		try {
			await reader.cancel();
		} catch {}
		try {
			reader.releaseLock();
		} catch {}
	}
}

// ============================================================================
// WebSocket Parsing
// ============================================================================

const OPENAI_BETA_RESPONSES_WEBSOCKETS = "responses_websockets=2026-02-06";
const SESSION_WEBSOCKET_CACHE_TTL_MS = 5 * 60 * 1000;

type WebSocketEventType = "open" | "message" | "error" | "close";
type WebSocketListener = (event: unknown) => void;

interface WebSocketLike {
	close(code?: number, reason?: string): void;
	send(data: string): void;
	addEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
	removeEventListener(type: WebSocketEventType, listener: WebSocketListener): void;
}

interface CachedWebSocketContinuationState {
	lastRequestBody: RequestBody;
	lastResponseId: string;
	lastResponseItems: ResponseInput;
	/** Length of input prefix verified equal to baseline on the last cache hit. */
	verifiedPrefixLen?: number;
}

interface CachedWebSocketConnection {
	socket: WebSocketLike;
	busy: boolean;
	idleTimer?: ReturnType<typeof setTimeout>;
	continuation?: CachedWebSocketContinuationState;
}

export interface OpenAICodexWebSocketDebugStats {
	requests: number;
	connectionsCreated: number;
	connectionsReused: number;
	cachedContextRequests: number;
	storeTrueRequests: number;
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	websocketFailures: number;
	sseFallbacks: number;
	websocketFallbackActive?: boolean;
	lastWebSocketError?: string;
}

const websocketSessionCache = new Map<string, CachedWebSocketConnection>();
const websocketDebugStats = new Map<string, OpenAICodexWebSocketDebugStats>();
const websocketSseFallbackSessions = new Set<string>();

function getOrCreateWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats {
	let stats = websocketDebugStats.get(sessionId);
	if (!stats) {
		stats = {
			requests: 0,
			connectionsCreated: 0,
			connectionsReused: 0,
			cachedContextRequests: 0,
			storeTrueRequests: 0,
			fullContextRequests: 0,
			deltaRequests: 0,
			lastInputItems: 0,
			websocketFailures: 0,
			sseFallbacks: 0,
		};
		websocketDebugStats.set(sessionId, stats);
	}
	return stats;
}

export function getOpenAICodexWebSocketDebugStats(sessionId: string): OpenAICodexWebSocketDebugStats | undefined {
	const stats = websocketDebugStats.get(sessionId);
	return stats ? { ...stats } : undefined;
}

export function resetOpenAICodexWebSocketDebugStats(sessionId?: string): void {
	if (sessionId) {
		websocketDebugStats.delete(sessionId);
		websocketSseFallbackSessions.delete(sessionId);
		return;
	}
	websocketDebugStats.clear();
	websocketSseFallbackSessions.clear();
}

export function closeOpenAICodexWebSocketSessions(sessionId?: string): void {
	const closeEntry = (entry: CachedWebSocketConnection) => {
		if (entry.idleTimer) clearTimeout(entry.idleTimer);
		closeWebSocketSilently(entry.socket, 1000, "debug_close");
	};
	if (sessionId) {
		const entry = websocketSessionCache.get(sessionId);
		if (entry) closeEntry(entry);
		websocketSessionCache.delete(sessionId);
		return;
	}
	for (const entry of websocketSessionCache.values()) {
		closeEntry(entry);
	}
	websocketSessionCache.clear();
}

registerSessionResourceCleanup(closeOpenAICodexWebSocketSessions);

function isWebSocketSseFallbackActive(sessionId: string | undefined): boolean {
	return sessionId ? websocketSseFallbackSessions.has(sessionId) : false;
}

function recordWebSocketSseFallback(sessionId: string | undefined): void {
	if (!sessionId) return;
	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.sseFallbacks++;
	stats.websocketFallbackActive = isWebSocketSseFallbackActive(sessionId);
}

function recordWebSocketFailure(sessionId: string | undefined, error: unknown): void {
	if (!sessionId) return;
	websocketSseFallbackSessions.add(sessionId);

	const stats = getOrCreateWebSocketDebugStats(sessionId);
	stats.websocketFailures++;
	stats.lastWebSocketError = formatThrownValue(error);
	stats.websocketFallbackActive = true;
}

type WebSocketConstructor = new (
	url: string,
	protocols?: string | string[] | { headers?: Record<string, string> },
) => WebSocketLike;

let _cachedWebsocket: WebSocketConstructor | null = null;
async function getWebSocketConstructor(): Promise<WebSocketConstructor | null> {
	if (_cachedWebsocket) return _cachedWebsocket;

	// bun doesn't respect http proxy envs, ref: https://github.com/oven-sh/bun/issues/15489
	// TODO: remove this when bun supports proxy envs in websocket.
	if (
		process?.versions?.bun &&
		(process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy)
	) {
		const m = await dynamicImport("proxy-from-env");
		const getProxyForUrl = (m as { getProxyForUrl: (url: string | object | URL) => string }).getProxyForUrl;

		_cachedWebsocket = class extends WebSocket {
			constructor(url: string | URL, options?: string | string[] | Record<string, unknown>) {
				let _opts: Record<string, unknown> = {};
				if (Array.isArray(options) || typeof options === "string") {
					_opts = { protocols: options };
				} else {
					_opts = { ...options };
				}

				const proxy = getProxyForUrl(url.toString().replace(/^wss:/, "https:").replace(/^ws:/, "http:"));
				super(url, { ..._opts, ...(proxy ? { proxy } : {}) } as any);
			}
		};
		return _cachedWebsocket;
	}

	const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
	if (typeof ctor !== "function") return null;
	return ctor as unknown as WebSocketConstructor;
}

class WebSocketCloseError extends Error {
	readonly code?: number;
	readonly reason?: string;
	readonly wasClean?: boolean;

	constructor(message: string, options?: { code?: number; reason?: string; wasClean?: boolean }) {
		super(message);
		this.name = "WebSocketCloseError";
		this.code = options?.code;
		this.reason = options?.reason;
		this.wasClean = options?.wasClean;
	}
}

function getWebSocketReadyState(socket: WebSocketLike): number | undefined {
	const readyState = (socket as { readyState?: unknown }).readyState;
	return typeof readyState === "number" ? readyState : undefined;
}

function isWebSocketReusable(socket: WebSocketLike): boolean {
	const readyState = getWebSocketReadyState(socket);
	// If readyState is unavailable, assume the runtime keeps it open/reusable.
	return readyState === undefined || readyState === 1;
}

function closeWebSocketSilently(socket: WebSocketLike, code = 1000, reason = "done"): void {
	try {
		socket.close(code, reason);
	} catch {}
}

function scheduleSessionWebSocketExpiry(sessionId: string, entry: CachedWebSocketConnection): void {
	if (entry.idleTimer) {
		clearTimeout(entry.idleTimer);
	}
	entry.idleTimer = setTimeout(() => {
		// Drop our own handle first so a later clearTimeout can't target a fired
		// timer, then bail if the slot was reused/replaced (delete only OUR entry).
		entry.idleTimer = undefined;
		if (entry.busy) return;
		closeWebSocketSilently(entry.socket, 1000, "idle_timeout");
		if (websocketSessionCache.get(sessionId) === entry) {
			websocketSessionCache.delete(sessionId);
		}
	}, SESSION_WEBSOCKET_CACHE_TTL_MS);
	(entry.idleTimer as { unref?: () => void }).unref?.();
}

async function connectWebSocket(
	url: string,
	headers: Headers,
	signal?: AbortSignal,
	connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<WebSocketLike> {
	const WebSocketCtor = await getWebSocketConstructor();
	if (!WebSocketCtor) {
		throw new Error("WebSocket transport is not available in this runtime");
	}

	const wsHeaders = headersToRecord(headers);
	delete wsHeaders["OpenAI-Beta"];

	return new Promise<WebSocketLike>((resolve, reject) => {
		let settled = false;
		let socket: WebSocketLike;
		let connectTimer: ReturnType<typeof setTimeout> | undefined;

		try {
			socket = new WebSocketCtor(url, { headers: wsHeaders });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}

		const onOpen: WebSocketListener = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(socket);
		};
		const onError: WebSocketListener = (event) => {
			const error = extractWebSocketError(event);
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onClose: WebSocketListener = (event) => {
			const error = extractWebSocketCloseError(event);
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.close(1000, "aborted");
			reject(new Error("Request was aborted"));
		};
		const onConnectTimeout = () => {
			if (settled) return;
			settled = true;
			cleanup();
			socket.close(1000, "connect_timeout");
			reject(new Error("WebSocket connect timed out"));
		};

		const cleanup = () => {
			if (connectTimer !== undefined) {
				clearTimeout(connectTimer);
				connectTimer = undefined;
			}
			socket.removeEventListener("open", onOpen);
			socket.removeEventListener("error", onError);
			socket.removeEventListener("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};

		socket.addEventListener("open", onOpen);
		socket.addEventListener("error", onError);
		socket.addEventListener("close", onClose);
		signal?.addEventListener("abort", onAbort);
		if (connectTimeoutMs > 0) {
			connectTimer = setTimeout(onConnectTimeout, connectTimeoutMs);
		}
	});
}

async function acquireWebSocket(
	url: string,
	headers: Headers,
	sessionId: string | undefined,
	signal?: AbortSignal,
	connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
): Promise<{
	socket: WebSocketLike;
	entry?: CachedWebSocketConnection;
	reused: boolean;
	release: (options?: { keep?: boolean }) => void;
}> {
	if (!sessionId) {
		const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
		return {
			socket,
			reused: false,
			// A connection without a sessionId is never cacheable/reusable, so always
			// close it on release regardless of `keep`.
			release: () => {
				closeWebSocketSilently(socket);
			},
		};
	}

	const cached = websocketSessionCache.get(sessionId);
	if (cached) {
		if (cached.idleTimer) {
			clearTimeout(cached.idleTimer);
			cached.idleTimer = undefined;
		}
		if (!cached.busy && isWebSocketReusable(cached.socket)) {
			cached.busy = true;
			return {
				socket: cached.socket,
				entry: cached,
				reused: true,
				release: ({ keep } = {}) => {
					if (!keep || !isWebSocketReusable(cached.socket)) {
						closeWebSocketSilently(cached.socket);
						websocketSessionCache.delete(sessionId);
						return;
					}
					cached.busy = false;
					scheduleSessionWebSocketExpiry(sessionId, cached);
				},
			};
		}
		if (cached.busy) {
			const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
			return {
				socket,
				reused: false,
				release: () => {
					closeWebSocketSilently(socket);
				},
			};
		}
		if (!isWebSocketReusable(cached.socket)) {
			closeWebSocketSilently(cached.socket);
			websocketSessionCache.delete(sessionId);
		}
	}

	const socket = await connectWebSocket(url, headers, signal, connectTimeoutMs);
	const entry: CachedWebSocketConnection = { socket, busy: true };
	websocketSessionCache.set(sessionId, entry);
	return {
		socket,
		entry,
		reused: false,
		release: ({ keep } = {}) => {
			if (!keep || !isWebSocketReusable(entry.socket)) {
				closeWebSocketSilently(entry.socket);
				if (entry.idleTimer) clearTimeout(entry.idleTimer);
				if (websocketSessionCache.get(sessionId) === entry) {
					websocketSessionCache.delete(sessionId);
				}
				return;
			}
			entry.busy = false;
			scheduleSessionWebSocketExpiry(sessionId, entry);
		},
	};
}

function extractWebSocketError(event: unknown): Error {
	if (event && typeof event === "object") {
		const message = "message" in event ? (event as { message?: unknown }).message : undefined;
		if (typeof message === "string" && message.length > 0) {
			return new Error(message);
		}

		const nestedError = "error" in event ? (event as { error?: unknown }).error : undefined;
		if (nestedError instanceof Error && nestedError.message.length > 0) {
			return nestedError;
		}
		if (nestedError && typeof nestedError === "object" && "message" in nestedError) {
			const nestedMessage = (nestedError as { message?: unknown }).message;
			if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
				return new Error(nestedMessage);
			}
		}
	}
	return new Error("WebSocket error");
}

function extractWebSocketCloseError(event: unknown): Error {
	if (event && typeof event === "object") {
		const code = "code" in event ? (event as { code?: unknown }).code : undefined;
		const reason = "reason" in event ? (event as { reason?: unknown }).reason : undefined;
		const wasClean = "wasClean" in event ? (event as { wasClean?: unknown }).wasClean : undefined;
		const codeText = typeof code === "number" ? ` ${code}` : "";
		let reasonText = typeof reason === "string" && reason.length > 0 ? ` ${reason}` : "";
		if (!reasonText && code === WEBSOCKET_MESSAGE_TOO_BIG_CLOSE_CODE) {
			reasonText = " message too big";
		}
		return new WebSocketCloseError(`WebSocket closed${codeText}${reasonText}`.trim(), {
			code: typeof code === "number" ? code : undefined,
			reason: typeof reason === "string" && reason.length > 0 ? reason : undefined,
			wasClean: typeof wasClean === "boolean" ? wasClean : undefined,
		});
	}
	return new Error("WebSocket closed");
}

// Reused for non-streaming WebSocket frame decodes (separate from the stateful
// streaming decoder in parseSSE).
const wsTextDecoder = new TextDecoder();

async function decodeWebSocketData(data: unknown): Promise<string | null> {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) {
		return wsTextDecoder.decode(new Uint8Array(data));
	}
	if (ArrayBuffer.isView(data)) {
		const view = data as ArrayBufferView;
		return wsTextDecoder.decode(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
	}
	if (data && typeof data === "object" && "arrayBuffer" in data) {
		const blobLike = data as { arrayBuffer: () => Promise<ArrayBuffer> };
		const arrayBuffer = await blobLike.arrayBuffer();
		return wsTextDecoder.decode(new Uint8Array(arrayBuffer));
	}
	return null;
}

async function* parseWebSocket(
	socket: WebSocketLike,
	signal?: AbortSignal,
	idleMs: number = DEFAULT_IDLE_TIMEOUT_MS,
): AsyncGenerator<Record<string, unknown>> {
	const queue: Record<string, unknown>[] = [];
	let pending: (() => void) | null = null;
	let done = false;
	let failed: Error | null = null;
	let sawCompletion = false;

	const wake = () => {
		if (!pending) return;
		const resolve = pending;
		pending = null;
		resolve();
	};

	// Serialize frame decode+enqueue through a promise-chain. decodeWebSocketData
	// is async (Blob/ArrayBuffer await a real boundary), so fire-and-forget could
	// let a later string frame enqueue before an earlier binary one. Chaining each
	// frame after the previous preserves arrival order and bounds in-flight work to
	// one decode at a time (natural backpressure). The happy path (few spaced
	// frames) is unchanged — the chain stays resolved between frames.
	let tail: Promise<void> = Promise.resolve();

	const decodeAndEmit = async (data: unknown): Promise<void> => {
		let text: string | null = null;
		try {
			text = await decodeWebSocketData(data);
			if (!text) return;
			const parsed = JSON.parse(text) as Record<string, unknown>;
			const type = typeof parsed.type === "string" ? parsed.type : "";
			if (type === "response.completed" || type === "response.done" || type === "response.incomplete") {
				sawCompletion = true;
				done = true;
			}
			queue.push(parsed);
			wake();
		} catch (cause) {
			failed = new CodexProtocolError(`Invalid Codex WebSocket JSON: ${formatThrownValue(cause)}`, {
				cause,
				payload: text,
			});
			done = true;
			wake();
		}
	};

	const onMessage: WebSocketListener = (event) => {
		if (!event || typeof event !== "object" || !("data" in event)) return;
		const data = (event as { data?: unknown }).data;
		tail = tail.then(() => decodeAndEmit(data));
	};

	const onError: WebSocketListener = (event) => {
		failed = extractWebSocketError(event);
		done = true;
		wake();
	};

	const onClose: WebSocketListener = (event) => {
		if (sawCompletion) {
			done = true;
			wake();
			return;
		}
		if (!failed) {
			failed = extractWebSocketCloseError(event);
		}
		done = true;
		wake();
	};

	const onAbort = () => {
		failed = new Error("Request was aborted");
		done = true;
		wake();
	};

	socket.addEventListener("message", onMessage);
	socket.addEventListener("error", onError);
	socket.addEventListener("close", onClose);
	signal?.addEventListener("abort", onAbort);

	try {
		// Cursor over the queue instead of shift() (O(n) per dequeue); compact
		// periodically so consumed entries don't pin memory. Mirrors parseSSE.
		let head = 0;
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}
			if (head < queue.length) {
				const item = queue[head++]!;
				if (head > 1024) {
					queue.splice(0, head);
					head = 0;
				}
				yield item;
				continue;
			}
			if (done) break;
			let idleTimer: ReturnType<typeof setTimeout> | undefined;
			const woke = await new Promise<boolean>((resolve) => {
				pending = () => resolve(true);
				idleTimer = setTimeout(() => resolve(false), idleMs);
			});
			if (idleTimer !== undefined) {
				clearTimeout(idleTimer);
			}
			if (!woke) {
				// Idle watchdog: a half-open WebSocket (no frame, no close/error event)
				// would otherwise leave this await pending forever — the turn hangs with no
				// error and no retry. Treat prolonged silence as a dead socket and surface a
				// retryable error so the normal retry/fallback path takes over.
				recordDiagnostic({
					category: "stream.idle-timeout",
					level: "warn",
					source: "openai-codex-responses.parseWebSocket",
					context: { ms: idleMs, note: "websocket idle watchdog" },
				});
				pending = null;
				failed = new IdleStreamTimeoutError(idleMs);
				done = true;
				break;
			}
		}

		if (failed) {
			throw failed;
		}
		if (!sawCompletion) {
			throw new Error("WebSocket stream closed before response.completed");
		}
	} finally {
		socket.removeEventListener("message", onMessage);
		socket.removeEventListener("error", onError);
		socket.removeEventListener("close", onClose);
		signal?.removeEventListener("abort", onAbort);
	}
}

function requestBodyWithoutInput(body: RequestBody): RequestBody {
	const { input: _input, previous_response_id: _previousResponseId, ...rest } = body;
	return rest;
}

function shallowContentEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const left = a[i];
		const right = b[i];
		if (left === right) continue;
		if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
			return false;
		}
		const lo = left as Record<string, unknown>;
		const ro = right as Record<string, unknown>;
		const keys = Object.keys(lo);
		if (keys.length !== Object.keys(ro).length) return false;
		for (const key of keys) {
			if (!(key in ro)) return false;
			const lv = lo[key];
			const rv = ro[key];
			if (lv === rv) continue;
			// One more level for empty arrays like annotations: [] on rebuilt messages.
			if (Array.isArray(lv) && Array.isArray(rv)) {
				if (lv.length !== rv.length) return false;
				for (let j = 0; j < lv.length; j++) {
					if (lv[j] !== rv[j]) return false;
				}
				continue;
			}
			return false;
		}
	}
	return true;
}

function responseInputItemEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	// Structural compare on known ResponseInput fields — avoid JSON.stringify of
	// large nested payloads on every websocket-cached continuation probe.
	if (ao.type !== bo.type || ao.id !== bo.id || ao.role !== bo.role) return false;
	if (!shallowContentEqual(ao.content, bo.content)) return false;
	for (const key of Object.keys(ao)) {
		if (key === "type" || key === "id" || key === "role" || key === "content") continue;
		if (!(key in bo) || ao[key] !== bo[key]) return false;
	}
	for (const key of Object.keys(bo)) {
		if (key === "type" || key === "id" || key === "role" || key === "content") continue;
		if (!(key in ao)) return false;
	}
	return true;
}

function responseInputsEqual(a: ResponseInput | undefined, b: ResponseInput | undefined): boolean {
	const aVal = a ?? [];
	const bVal = b ?? [];
	if (aVal.length !== bVal.length) return false;
	for (let i = 0; i < aVal.length; i++) {
		if (!responseInputItemEqual(aVal[i], bVal[i])) return false;
	}
	return true;
}

function requestBodiesMatchExceptInput(a: RequestBody, b: RequestBody): boolean {
	const ra = requestBodyWithoutInput(a);
	const rb = requestBodyWithoutInput(b);
	const keysA = Object.keys(ra).sort();
	const keysB = Object.keys(rb).sort();
	if (keysA.length !== keysB.length) return false;
	for (let i = 0; i < keysA.length; i++) {
		if (keysA[i] !== keysB[i]) return false;
		const key = keysA[i];
		if (JSON.stringify(ra[key]) !== JSON.stringify(rb[key])) return false;
	}
	return true;
}

function getCachedWebSocketInputDelta(
	body: RequestBody,
	continuation: CachedWebSocketContinuationState,
): ResponseInput | undefined {
	if (!requestBodiesMatchExceptInput(body, continuation.lastRequestBody)) {
		return undefined;
	}

	const currentInput = body.input ?? [];
	const baseline = [...(continuation.lastRequestBody.input ?? []), ...continuation.lastResponseItems];
	const baselineLen = baseline.length;
	if (currentInput.length < baselineLen) {
		return undefined;
	}

	if (continuation.verifiedPrefixLen === baselineLen && currentInput.length === baselineLen) {
		return undefined;
	}

	const prefix = currentInput.slice(0, baselineLen);
	if (!responseInputsEqual(prefix, baseline)) {
		continuation.verifiedPrefixLen = undefined;
		return undefined;
	}
	continuation.verifiedPrefixLen = baselineLen;

	return currentInput.slice(baselineLen);
}

function buildCachedWebSocketRequestBody(entry: CachedWebSocketConnection, body: RequestBody): RequestBody {
	const continuation = entry.continuation;
	if (!continuation) {
		return body;
	}

	const delta = getCachedWebSocketInputDelta(body, continuation);
	if (!delta || !continuation.lastResponseId) {
		entry.continuation = undefined;
		return body;
	}

	return {
		...body,
		previous_response_id: continuation.lastResponseId,
		input: delta,
	};
}

async function* startWebSocketOutputOnFirstEvent(
	events: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onStart: () => void,
): AsyncGenerator<ResponseStreamEvent> {
	let started = false;
	for await (const event of events) {
		if (!started) {
			started = true;
			onStart();
			stream.push({ type: "start", partial: output });
		}
		yield event;
	}
}

async function processWebSocketStream(
	url: string,
	body: RequestBody,
	headers: Headers,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<"openai-codex-responses">,
	onStart: () => void,
	options?: OpenAICodexResponsesOptions,
	toolNameGuard: ToolNameGuard = NOOP_TOOL_NAME_GUARD,
): Promise<void> {
	const timeouts = resolveStreamTimeouts(options);
	const { socket, entry, reused, release } = await acquireWebSocket(
		url,
		headers,
		options?.sessionId,
		options?.signal,
		timeouts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
	);
	// keepConnection drives release({ keep }) in finally. The try spans EVERY use
	// of the acquired connection (stats prep + body build + send + stream) so that
	// any throw or abort between acquire and stream end still routes through
	// release — otherwise a freshly-cached busy entry leaks (socket open, pinned in
	// the cache, never reusable, never expired since the idle timer skips busy).
	let keepConnection = true;
	const useCachedContext = options?.transport === "websocket-cached" || options?.transport === "auto";
	try {
		// ChatGPT Codex Responses rejects `store: true` ("Store must be set to false").
		// WebSocket continuation still works via connection-scoped previous_response_id state.
		const fullBody = body;
		const requestBody = useCachedContext && entry ? buildCachedWebSocketRequestBody(entry, fullBody) : fullBody;
		const stats = options?.sessionId ? getOrCreateWebSocketDebugStats(options.sessionId) : undefined;
		if (stats) {
			stats.requests++;
			if (reused) stats.connectionsReused++;
			else stats.connectionsCreated++;
			if (useCachedContext) stats.cachedContextRequests++;
			if (requestBody.store === true) stats.storeTrueRequests++;
			stats.lastInputItems = requestBody.input?.length ?? 0;
			if (requestBody.previous_response_id) {
				stats.deltaRequests++;
				stats.lastDeltaInputItems = requestBody.input?.length ?? 0;
				stats.lastPreviousResponseId = requestBody.previous_response_id;
			} else {
				stats.fullContextRequests++;
				stats.lastDeltaInputItems = undefined;
				stats.lastPreviousResponseId = undefined;
			}
		}
		socket.send(JSON.stringify({ type: "response.create", ...requestBody }));
		await processResponsesStream(
			startWebSocketOutputOnFirstEvent(
				mapCodexEvents(parseWebSocket(socket, options?.signal, options?.idleTimeoutMs)),
				output,
				stream,
				onStart,
			),
			output,
			stream,
			model,
			{
				toolNameGuard,
				serviceTier: options?.serviceTier,
				resolveServiceTier: resolveCodexServiceTier,
				applyServiceTierPricing: (usage, serviceTier) => applyServiceTierPricing(usage, serviceTier, model),
			},
		);
		if (options?.signal?.aborted) {
			keepConnection = false;
		} else if (useCachedContext && entry && output.responseId) {
			const responseItems = convertResponsesMessages(
				model,
				{ messages: [output] },
				RESPONSES_TOOL_CALL_PROVIDERS,
				{
					includeSystemPrompt: false,
				},
				toolNameGuard,
			).filter((item) => item.type !== "function_call_output");
			entry.continuation = {
				lastRequestBody: fullBody,
				lastResponseId: output.responseId,
				lastResponseItems: responseItems,
			};
		}
	} catch (error) {
		if (entry) {
			entry.continuation = undefined;
		}
		keepConnection = false;
		throw error;
	} finally {
		release({ keep: keepConnection });
	}
}

// ============================================================================
// Error Handling
// ============================================================================

async function parseErrorResponse(response: Response): Promise<{ message: string; friendlyMessage?: string }> {
	const raw = await response.text();
	let message = raw || response.statusText || "Request failed";
	let friendlyMessage: string | undefined;

	try {
		const parsed = JSON.parse(raw) as {
			error?: { code?: string; type?: string; message?: string; plan_type?: string; resets_at?: number };
		};
		const err = parsed?.error;
		if (err) {
			const code = err.code || err.type || "";
			if (/usage_limit_reached|usage_not_included|rate_limit_exceeded/i.test(code) || response.status === 429) {
				const plan = err.plan_type ? ` (${err.plan_type.toLowerCase()} plan)` : "";
				const mins = err.resets_at
					? Math.max(0, Math.round((err.resets_at * 1000 - Date.now()) / 60000))
					: undefined;
				const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
				friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
			}
			message = err.message || friendlyMessage || message;
		}
	} catch {}

	return { message, friendlyMessage };
}

// ============================================================================
// Auth & Headers
// ============================================================================

function extractAccountId(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) throw new Error("Invalid token");
		// JWT segments are base64url; atob() only accepts standard base64 and
		// throws "Invalid character" on '-'/'_'. Normalize + pad before decoding.
		const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
		const payload = JSON.parse(atob(padded));
		const accountId = payload?.[JWT_CLAIM_PATH]?.chatgpt_account_id;
		if (!accountId) throw new Error("No account ID in token");
		return accountId;
	} catch {
		throw new Error("Failed to extract accountId from token");
	}
}

function createCodexRequestId(): string {
	if (typeof globalThis.crypto?.randomUUID === "function") {
		return globalThis.crypto.randomUUID();
	}
	return `codex_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildBaseCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
): Headers {
	const headers = new Headers(initHeaders);
	for (const [key, value] of Object.entries(additionalHeaders || {})) {
		headers.set(key, value);
	}
	headers.set("Authorization", `Bearer ${token}`);
	headers.set("chatgpt-account-id", accountId);
	headers.set("originator", "pi");
	const userAgent = _os ? `pit (${_os.platform()} ${_os.release()}; ${_os.arch()})` : "pit (browser)";
	headers.set("User-Agent", userAgent);
	return headers;
}

function buildSSEHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	sessionId?: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.set("OpenAI-Beta", "responses=experimental");
	headers.set("accept", "text/event-stream");
	headers.set("content-type", "application/json");

	if (sessionId) {
		headers.set("session_id", sessionId);
		headers.set("x-client-request-id", sessionId);
	}

	return headers;
}

function buildWebSocketHeaders(
	initHeaders: Record<string, string> | undefined,
	additionalHeaders: Record<string, string> | undefined,
	accountId: string,
	token: string,
	requestId: string,
): Headers {
	const headers = buildBaseCodexHeaders(initHeaders, additionalHeaders, accountId, token);
	headers.delete("accept");
	headers.delete("content-type");
	headers.delete("OpenAI-Beta");
	headers.delete("openai-beta");
	headers.set("OpenAI-Beta", OPENAI_BETA_RESPONSES_WEBSOCKETS);
	headers.set("x-client-request-id", requestId);
	headers.set("session_id", requestId);
	return headers;
}
