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

	constructor(name: string, config: McpServerConfig) {
		this.name = name;
		this.config = config;
	}

	updateConfig(config: McpServerConfig): void {
		this.config = config;
	}

	async start(signal?: AbortSignal): Promise<void> {
		this.disposeChannel();
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
			void this.runChannel(response.body as ReadableStream<Uint8Array>, controller.signal, () => {
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
		onEndpoint: () => void,
	): Promise<void> {
		try {
			for await (const ev of parseSseStream(body, { signal, label: `MCP ${this.name} sse` })) {
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
			this.onChannelClosed(new McpTransportError(`MCP ${this.name}: SSE channel closed`));
		} catch (err) {
			this.onChannelClosed(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private onChannelClosed(error: Error): void {
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

		const responsePromise = new Promise<JsonRpcResponse<T>>((resolve, reject) => {
			const onAbort = () => {
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
				signal,
			});
		} catch (error) {
			const p = this.pending.get(message.id);
			if (p) {
				this.pending.delete(message.id);
				clearTimeout(p.timer);
			}
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
				return inline;
			}
		}
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
