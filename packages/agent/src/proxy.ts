/**
 * Proxy stream function for apps that route LLM calls through a server.
 * The server manages auth and proxies requests to LLM providers.
 */

// Internal import for JSON parsing utility
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	type Context,
	EventStream,
	type Model,
	parseStreamingJson,
	type SimpleStreamOptions,
	type StopReason,
	type ToolCall,
} from "@pit/ai";

// Hard cap on the SSE line-accumulation buffer (and on any single `data:`
// payload). A well-behaved proxy emits newline-delimited frames far smaller
// than this; a body that never breaks on a newline would otherwise grow the
// buffer without bound until the process OOMs. 16 MiB is generous for any
// legitimate single event while still bounding worst-case memory.
const MAX_STREAM_BUFFER_BYTES = 16 * 1024 * 1024;

// Create stream class matching ProxyMessageEventStream
class ProxyMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

/**
 * Proxy event types - server sends these with partial field stripped to reduce bandwidth.
 */
export type ProxyAssistantMessageEvent =
	| { type: "start" }
	| { type: "text_start"; contentIndex: number }
	| { type: "text_delta"; contentIndex: number; delta: string }
	| { type: "text_end"; contentIndex: number; contentSignature?: string }
	| { type: "thinking_start"; contentIndex: number }
	| { type: "thinking_delta"; contentIndex: number; delta: string }
	| { type: "thinking_end"; contentIndex: number; contentSignature?: string }
	| { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
	| { type: "toolcall_delta"; contentIndex: number; delta: string }
	| { type: "toolcall_end"; contentIndex: number }
	| {
			type: "done";
			reason: Extract<StopReason, "stop" | "length" | "toolUse">;
			usage: AssistantMessage["usage"];
	  }
	| {
			type: "error";
			reason: Extract<StopReason, "aborted" | "error">;
			errorMessage?: string;
			usage: AssistantMessage["usage"];
	  };

type ProxySerializableStreamOptions = Pick<
	SimpleStreamOptions,
	| "temperature"
	| "maxTokens"
	| "reasoning"
	| "cacheRetention"
	| "sessionId"
	| "headers"
	| "metadata"
	| "transport"
	| "thinkingBudgets"
	| "maxRetryDelayMs"
>;

export interface ProxyStreamOptions extends ProxySerializableStreamOptions {
	/** Local abort signal for the proxy request */
	signal?: AbortSignal;
	/** Auth token for the proxy server */
	authToken: string;
	/** Proxy server URL (e.g., "https://genai.example.com") */
	proxyUrl: string;
}

/**
 * Stream function that proxies through a server instead of calling LLM providers directly.
 * The server strips the partial field from delta events to reduce bandwidth.
 * We reconstruct the partial message client-side.
 *
 * Use this as the `streamFn` option when creating an Agent that needs to go through a proxy.
 *
 * @example
 * ```typescript
 * const agent = new Agent({
 *   streamFn: (model, context, options) =>
 *     streamProxy(model, context, {
 *       ...options,
 *       authToken: await getAuthToken(),
 *       proxyUrl: "https://genai.example.com",
 *     }),
 * });
 * ```
 */
function buildProxyRequestOptions(options: ProxyStreamOptions): ProxySerializableStreamOptions {
	return {
		temperature: options.temperature,
		maxTokens: options.maxTokens,
		reasoning: options.reasoning,
		cacheRetention: options.cacheRetention,
		sessionId: options.sessionId,
		headers: options.headers,
		metadata: options.metadata,
		transport: options.transport,
		thinkingBudgets: options.thinkingBudgets,
		maxRetryDelayMs: options.maxRetryDelayMs,
	};
}

export function streamProxy(model: Model<any>, context: Context, options: ProxyStreamOptions): ProxyMessageEventStream {
	const stream = new ProxyMessageEventStream();

	(async () => {
		// Initialize the partial message that we'll build up from events
		const partial: AssistantMessage = {
			role: "assistant",
			stopReason: "stop",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};

		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

		const abortHandler = () => {
			if (reader) {
				reader.cancel("Request aborted by user").catch(() => {});
			}
		};

		if (options.signal) {
			options.signal.addEventListener("abort", abortHandler);
		}

		// Connect-phase timeout only: abort if headers don't arrive in time, but
		// clear once the response resolves so a long generation stream isn't killed.
		const connectController = new AbortController();
		const onUserAbort = () => connectController.abort();
		options.signal?.addEventListener("abort", onUserAbort);
		const connectTimer = setTimeout(() => {
			connectController.abort(new Error("Proxy connect timeout after 60s"));
		}, 60_000);

		try {
			const response = await fetch(`${options.proxyUrl}/api/stream`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${options.authToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					context,
					options: buildProxyRequestOptions(options),
				}),
				signal: connectController.signal,
			});
			clearTimeout(connectTimer);

			if (!response.ok) {
				let errorMessage = `Proxy error: ${response.status} ${response.statusText}`;
				try {
					const errorData = (await response.json()) as { error?: string };
					if (errorData.error) {
						errorMessage = `Proxy error: ${errorData.error}`;
					}
				} catch {
					// Couldn't parse error response
				}
				throw new Error(errorMessage);
			}

			reader = response.body!.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			let sawTerminal = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				if (options.signal?.aborted) {
					throw new Error("Request aborted by user");
				}

				buffer += decoder.decode(value, { stream: true });

				// Guard against a hostile/malformed 200 body that never emits a
				// newline (e.g. one giant JSON blob, wrong content type, or raw
				// bytes from a proxy bug). Without a cap, `buffer` accumulates every
				// chunk for the full stream duration and OOMs the process. Treat an
				// over-long unbroken buffer as a protocol error and stop reading.
				if (buffer.length > MAX_STREAM_BUFFER_BYTES) {
					finalizeOpenToolCalls(partial);
					partial.stopReason = "error";
					partial.errorMessage = "Proxy stream exceeded max line buffer";
					stream.push({ type: "error", reason: "error", error: partial });
					sawTerminal = true;
					break;
				}

				const lines = buffer.split("\n");
				buffer = lines.pop() || "";

				let bufferOverflow = false;
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						const data = line.slice(6).trim();
						if (data) {
							// Cap the per-`data:` payload too, so a single oversized SSE
							// frame can't force a multi-megabyte JSON.parse.
							if (data.length > MAX_STREAM_BUFFER_BYTES) {
								finalizeOpenToolCalls(partial);
								partial.stopReason = "error";
								partial.errorMessage = "Proxy stream exceeded max line buffer";
								stream.push({ type: "error", reason: "error", error: partial });
								sawTerminal = true;
								bufferOverflow = true;
								break;
							}
							const proxyEvent = JSON.parse(data) as ProxyAssistantMessageEvent;
							const event = processProxyEvent(proxyEvent, partial);
							if (event) {
								if (event.type === "done" || event.type === "error") {
									sawTerminal = true;
								}
								stream.push(event);
								// A terminal `error` returned by `processProxyEvent` (e.g. the
								// tool-call argument cap was exceeded) means the message has
								// already been finalized; stop reading so we don't keep
								// accumulating bytes from a hostile/buggy proxy.
								if (event.type === "error") {
									bufferOverflow = true;
									break;
								}
							}
						}
					}
				}
				if (bufferOverflow) break;
			}

			if (options.signal?.aborted) {
				throw new Error("Request aborted by user");
			}

			// If the upstream connection closed cleanly without ever emitting a
			// terminal `done`/`error` event (truncated stream, dropped connection,
			// proxy crash after a 200), result() would never resolve and the agent
			// loop's `await response.result()` would hang forever. Synthesize a
			// terminal error so the consumer always sees a completion.
			if (!sawTerminal) {
				finalizeOpenToolCalls(partial);
				partial.stopReason = "error";
				partial.errorMessage = "Proxy stream ended without a terminal event";
				stream.push({ type: "error", reason: "error", error: partial });
			}

			stream.end();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const reason = options.signal?.aborted ? "aborted" : "error";
			finalizeOpenToolCalls(partial);
			partial.stopReason = reason;
			partial.errorMessage = errorMessage;
			stream.push({
				type: "error",
				reason,
				error: partial,
			});
			stream.end();
		} finally {
			clearTimeout(connectTimer);
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
				options.signal.removeEventListener("abort", onUserAbort);
			}
			// Release the body stream on every exit path (normal completion, parse
			// throw, or abort) so the underlying socket/connection is not pinned by
			// a locked reader until GC reclaims it.
			if (reader) {
				reader.cancel().catch(() => {});
			}
		}
	})();

	return stream;
}

// Frame budget (60fps) for re-parsing a streaming tool-call's accumulated
// partial JSON. Re-parsing the full buffer on every delta is O(N*M) for a
// tool call streamed in N chunks to a final size of M bytes; coalescing the
// re-parse to at most once per frame keeps live UI reactivity while making the
// streaming path effectively linear. The final, exact `arguments` value is
// always produced from the complete buffer on `toolcall_end`.
const TOOLCALL_PARSE_THROTTLE_MS = 16;

/**
 * Finalize any tool-call content blocks still carrying the transient streaming
 * fields (`partialJson`/`lastParseAt`). Normally these are stripped on
 * `toolcall_end`, but if the stream terminates via `done`/`error` while a tool
 * call is still open (truncated/aborted mid tool-call), those internal fields
 * would otherwise leak into the persisted transcript as enumerable junk and
 * `arguments` would retain the last throttled (possibly stale) parse. This
 * mirrors the `toolcall_end` finalization: produce the exact final arguments
 * from the complete buffer, then delete the carrier fields.
 */
function finalizeOpenToolCalls(partial: AssistantMessage): void {
	for (const content of partial.content) {
		if (content?.type !== "toolCall") continue;
		const carrier = content as ToolCall & { partialJson?: string; lastParseAt?: number };
		if (typeof carrier.partialJson === "string") {
			content.arguments = parseStreamingJson(carrier.partialJson) || {};
		}
		delete carrier.partialJson;
		delete carrier.lastParseAt;
	}
}

/**
 * Process a proxy event and update the partial message.
 */
function processProxyEvent(
	proxyEvent: ProxyAssistantMessageEvent,
	partial: AssistantMessage,
): AssistantMessageEvent | undefined {
	switch (proxyEvent.type) {
		case "start":
			return { type: "start", partial };

		case "text_start":
			partial.content[proxyEvent.contentIndex] = { type: "text", text: "" };
			return { type: "text_start", contentIndex: proxyEvent.contentIndex, partial };

		case "text_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.text += proxyEvent.delta;
				return {
					type: "text_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received text_delta for non-text content");
		}

		case "text_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "text") {
				content.textSignature = proxyEvent.contentSignature;
				return {
					type: "text_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.text,
					partial,
				};
			}
			throw new Error("Received text_end for non-text content");
		}

		case "thinking_start":
			partial.content[proxyEvent.contentIndex] = { type: "thinking", thinking: "" };
			return { type: "thinking_start", contentIndex: proxyEvent.contentIndex, partial };

		case "thinking_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinking += proxyEvent.delta;
				return {
					type: "thinking_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received thinking_delta for non-thinking content");
		}

		case "thinking_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "thinking") {
				content.thinkingSignature = proxyEvent.contentSignature;
				return {
					type: "thinking_end",
					contentIndex: proxyEvent.contentIndex,
					content: content.thinking,
					partial,
				};
			}
			throw new Error("Received thinking_end for non-thinking content");
		}

		case "toolcall_start":
			partial.content[proxyEvent.contentIndex] = {
				type: "toolCall",
				id: proxyEvent.id,
				name: proxyEvent.toolName,
				arguments: {},
				partialJson: "",
				lastParseAt: 0,
			} satisfies ToolCall & { partialJson: string; lastParseAt: number } as ToolCall;
			return { type: "toolcall_start", contentIndex: proxyEvent.contentIndex, partial };

		case "toolcall_delta": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const carrier = content as ToolCall & { partialJson: string; lastParseAt: number };
				carrier.partialJson += proxyEvent.delta;
				// Cap the accumulated tool-call argument buffer. The per-line and
				// per-`data:` guards (above) only bound a single SSE frame; a hostile
				// or buggy proxy can stream an unbounded tool-call argument as a long
				// series of individually-legal small frames, growing `partialJson`
				// (and the re-cloned partial content) without bound until OOM. Treat
				// an over-long accumulation as a protocol error, finalize open tool
				// calls, and emit a terminal error — mirroring the line-buffer
				// overflow handling in the read loop.
				if (carrier.partialJson.length > MAX_STREAM_BUFFER_BYTES) {
					finalizeOpenToolCalls(partial);
					partial.stopReason = "error";
					partial.errorMessage = "Proxy tool-call args exceeded max buffer";
					return { type: "error", reason: "error", error: partial };
				}
				// Re-parsing the full accumulated buffer on every delta is O(N*M).
				// Coalesce to at most once per frame; the intermediate `arguments`
				// value only drives live UI reactivity, and `toolcall_end` always
				// produces the exact final value from the complete buffer.
				const now = performance.now();
				if (now - carrier.lastParseAt >= TOOLCALL_PARSE_THROTTLE_MS) {
					carrier.lastParseAt = now;
					content.arguments = parseStreamingJson(carrier.partialJson) || {};
					// Only spread a fresh object when the throttled parse actually ran;
					// the clone exists solely to trigger UI reactivity for the updated
					// `arguments`, so cloning on every delta is wasted allocation churn.
					partial.content[proxyEvent.contentIndex] = { ...content };
				}
				return {
					type: "toolcall_delta",
					contentIndex: proxyEvent.contentIndex,
					delta: proxyEvent.delta,
					partial,
				};
			}
			throw new Error("Received toolcall_delta for non-toolCall content");
		}

		case "toolcall_end": {
			const content = partial.content[proxyEvent.contentIndex];
			if (content?.type === "toolCall") {
				const carrier = content as ToolCall & { partialJson?: string; lastParseAt?: number };
				// Always produce the exact final arguments from the complete buffer,
				// regardless of how the streaming re-parses were throttled above.
				if (typeof carrier.partialJson === "string") {
					content.arguments = parseStreamingJson(carrier.partialJson) || {};
				}
				delete carrier.partialJson;
				delete carrier.lastParseAt;
				return {
					type: "toolcall_end",
					contentIndex: proxyEvent.contentIndex,
					toolCall: content,
					partial,
				};
			}
			return undefined;
		}

		case "done":
			finalizeOpenToolCalls(partial);
			partial.stopReason = proxyEvent.reason;
			partial.usage = proxyEvent.usage;
			return { type: "done", reason: proxyEvent.reason, message: partial };

		case "error":
			finalizeOpenToolCalls(partial);
			partial.stopReason = proxyEvent.reason;
			partial.errorMessage = proxyEvent.errorMessage;
			partial.usage = proxyEvent.usage;
			return { type: "error", reason: proxyEvent.reason, error: partial };

		default: {
			const _exhaustiveCheck: never = proxyEvent;
			console.warn(`Unhandled proxy event type: ${(proxyEvent as any).type}`);
			return undefined;
		}
	}
}
