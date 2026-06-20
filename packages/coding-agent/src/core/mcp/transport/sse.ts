/**
 * Legacy HTTP+SSE transport (MCP spec 2024-11-05).
 *
 * Two channels: a long-lived GET that streams server→client `message` events,
 * and per-request POSTs to a server-advertised endpoint for client→server. On
 * connect the server sends an `endpoint` SSE event whose data is the POST URL.
 * JSON-RPC responses arrive asynchronously on the GET channel and are correlated
 * to their request by id (a POST returns 202 Accepted with no body, though some
 * servers answer inline — both are handled). Distinct from the modern Streamable
 * HTTP transport (`http.ts`), which multiplexes everything over one POST.
 */

import type { McpServerConfig } from "../types.ts";
import { parseSseStream } from "./sse-parse.ts";
import {
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type McpTransport,
	McpTransportError,
} from "./types.ts";

interface Pending {
	resolve: (response: JsonRpcResponse) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

const ENDPOINT_WAIT_MS = 15_000;

export class SseTransport implements McpTransport {
	onNotification?: (method: string, params?: Record<string, unknown>) => void;
	private name: string;
	private config: McpServerConfig;
	private postUrl?: string;
	private sessionId?: string;
	private pending = new Map<number | string, Pending>();
	private channelAbort?: AbortController;
	private closed = false;
	private closeError?: Error;
	// Monotonic generation tag. Each start() bumps it; the runChannel loop captures
	// its epoch so a superseded channel's async teardown can't close the live one.
	private channelEpoch = 0;

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
	}

	updateConfig(config: McpServerConfig): void {
		this.config = config;
	}

	async start(signal?: AbortSignal): Promise<void> {
		this.disposeChannel();
		// Open a new channel generation. The previous runChannel loop (now driven by
		// an aborted signal) will unwind on a later tick; tagging it stale here keeps
		// its onChannelClosed from rejecting this new connection's pending requests.
		const epoch = ++this.channelEpoch;
		this.closed = false;
		this.closeError = undefined;
		this.postUrl = undefined;

		const controller = new AbortController();
		this.channelAbort = controller;
		const onOuterAbort = () => controller.abort();
		signal?.addEventListener("abort", onOuterAbort, { once: true });

		let response: Response;
		try {
			response = await fetch(this.config.url ?? "", {
				method: "GET",
				headers: { accept: "text/event-stream", ...(this.config.headers ?? {}) },
				signal: controller.signal,
			});
		} catch (error) {
			signal?.removeEventListener("abort", onOuterAbort);
			throw new McpTransportError(
				`MCP ${this.name} sse-connect: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok || !response.body) {
			signal?.removeEventListener("abort", onOuterAbort);
			throw new McpTransportError(`MCP ${this.name} sse-connect: HTTP ${response.status}`);
		}
		const sid = response.headers.get("mcp-session-id");
		if (sid) this.sessionId = sid;

		// Resolve when the `endpoint` event arrives; reject if the channel ends or
		// times out first. The reader loop continues running in the background after.
		const endpointReady = new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() =>
					reject(
						new McpTransportError(`MCP ${this.name} sse-connect: no endpoint event within ${ENDPOINT_WAIT_MS}ms`),
					),
				ENDPOINT_WAIT_MS,
			);
			void this.runChannel(response.body as ReadableStream<Uint8Array>, controller.signal, epoch, () => {
				clearTimeout(timer);
				resolve();
			}).catch((err) => {
				clearTimeout(timer);
				reject(err instanceof Error ? err : new Error(String(err)));
			});
		});

		try {
			await endpointReady;
		} catch (err) {
			// start() failed (timeout / channel closed before `endpoint`): tear the
			// background GET reader down so its fetch+stream don't leak until the next
			// start()/dispose().
			this.disposeChannel();
			throw err;
		} finally {
			signal?.removeEventListener("abort", onOuterAbort);
		}
	}

	/** Background loop: read SSE frames, capture the endpoint, route responses. */
	private async runChannel(
		body: ReadableStream<Uint8Array>,
		signal: AbortSignal,
		epoch: number,
		onEndpoint: () => void,
	): Promise<void> {
		try {
			for await (const ev of parseSseStream(body, { signal, label: `MCP ${this.name} sse` })) {
				// A superseded channel may still drain a buffered frame after abort;
				// don't let it touch the live connection's endpoint or pending map.
				if (epoch !== this.channelEpoch) break;
				if (ev.event === "endpoint") {
					this.postUrl = new URL(ev.data, this.config.url ?? "").toString();
					onEndpoint();
				} else if (ev.event === "message" && ev.data) {
					let parsed: JsonRpcResponse & { method?: string; params?: Record<string, unknown> };
					try {
						parsed = JSON.parse(ev.data);
					} catch {
						continue;
					}
					if (parsed && "id" in parsed && parsed.id !== undefined && parsed.id !== null) {
						const p = this.pending.get(parsed.id);
						if (p) {
							this.pending.delete(parsed.id);
							clearTimeout(p.timer);
							p.resolve(parsed);
						}
					} else if (typeof parsed?.method === "string") {
						// Server-initiated notification (e.g. tools/list_changed).
						this.onNotification?.(parsed.method, parsed.params);
					}
				}
			}
			this.onChannelClosed(new McpTransportError(`MCP ${this.name}: SSE channel closed`), epoch);
		} catch (err) {
			this.onChannelClosed(err instanceof Error ? err : new Error(String(err)), epoch);
		}
	}

	private onChannelClosed(error: Error, epoch?: number): void {
		// A superseded channel's teardown must not close the live one. start() bumps
		// channelEpoch; if this close carries a stale epoch, ignore it.
		if (epoch !== undefined && epoch !== this.channelEpoch) return;
		if (this.closed) return;
		this.closed = true;
		this.closeError = error;
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			p.reject(error);
		}
		this.pending.clear();
	}

	async request<T = unknown>(
		message: JsonRpcRequest,
		signal?: AbortSignal,
		timeoutMs?: number,
	): Promise<JsonRpcResponse<T>> {
		if (this.closed) throw this.closeError ?? new McpTransportError(`MCP ${this.name}: SSE channel not open`);
		if (!this.postUrl) throw new McpTransportError(`MCP ${this.name}: SSE endpoint not yet known`);
		const effectiveTimeout = timeoutMs ?? this.config.timeoutMs ?? 30_000;

		let onAbort: () => void = () => {};
		const responsePromise = new Promise<JsonRpcResponse<T>>((resolve, reject) => {
			onAbort = () => {
				this.pending.delete(message.id);
				clearTimeout(timer);
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
		});

		// POST the request. Most servers answer 202 and deliver the result on the
		// GET channel; a few answer inline — if so, resolve directly.
		// Bound the POST itself with the request timeout (same pattern as notify()
		// and http.ts). Without this the function blocks on `await fetch` forever if
		// the endpoint accepts the connection but never sends response headers — the
		// responsePromise timer below only guards the *response* wait, which we never
		// reach. The catch path deletes the pending entry, so a timeout abort surfaces
		// as an McpTransportError instead of an unsettled promise.
		const postSignal = signal
			? AbortSignal.any([signal, AbortSignal.timeout(effectiveTimeout)])
			: AbortSignal.timeout(effectiveTimeout);
		let postResp: Response;
		try {
			postResp = await fetch(this.postUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.config.headers ?? {}),
					...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
				},
				body: JSON.stringify(message),
				signal: postSignal,
			});
		} catch (error) {
			const p = this.pending.get(message.id);
			if (p) {
				this.pending.delete(message.id);
				clearTimeout(p.timer);
			}
			signal?.removeEventListener("abort", onAbort);
			throw new McpTransportError(
				`MCP ${this.name} ${message.method}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!postResp.ok) {
			const p = this.pending.get(message.id);
			if (p) {
				this.pending.delete(message.id);
				clearTimeout(p.timer);
			}
			signal?.removeEventListener("abort", onAbort);
			const text = await postResp.text().catch(() => "");
			throw new McpTransportError(
				`MCP ${this.name} ${message.method}: HTTP ${postResp.status} ${text.slice(0, 200)}`,
			);
		}
		const ctype = postResp.headers.get("content-type") ?? "";
		if (ctype.includes("application/json")) {
			const inline = (await postResp.json().catch(() => undefined)) as JsonRpcResponse<T> | undefined;
			if (inline && "id" in inline && inline.id === message.id) {
				const p = this.pending.get(message.id);
				if (p) {
					this.pending.delete(message.id);
					clearTimeout(p.timer);
				}
				signal?.removeEventListener("abort", onAbort);
				return inline;
			}
		}
		// We are not using the POST body inline (non-JSON 2xx, or JSON whose id
		// did not match). Cancel any undrained body so the socket is released
		// back to the undici pool (same leak http.ts notify() guards against).
		await postResp.body?.cancel().catch(() => {});
		return responsePromise;
	}

	async notify(message: JsonRpcNotification, signal?: AbortSignal): Promise<void> {
		if (this.closed || !this.postUrl) return;
		try {
			await fetch(this.postUrl, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(this.config.headers ?? {}),
					...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
				},
				body: JSON.stringify(message),
				signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
			});
		} catch {
			/* non-fatal */
		}
	}

	private disposeChannel(): void {
		this.channelAbort?.abort();
		this.channelAbort = undefined;
	}

	dispose(): void {
		this.onChannelClosed(new McpTransportError(`MCP ${this.name}: transport disposed`));
		this.disposeChannel();
		this.sessionId = undefined;
		this.postUrl = undefined;
	}
}
