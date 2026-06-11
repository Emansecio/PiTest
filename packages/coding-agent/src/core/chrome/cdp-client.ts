/**
 * Minimal Chrome DevTools Protocol (CDP) client — no external deps.
 *
 * Targets are listed over HTTP (`GET /json`) with the global `fetch`; commands
 * and events flow over a WebSocket (the Node 22 global `WebSocket`, injectable
 * for tests). Commands are `{id, method, params}` → `{id, result|error}`;
 * events are `{method, params}` with no id. Mirrors the pending-map + timeout
 * pattern of the eval kernel (core/eval-kernel/javascript.ts).
 */

export interface CdpTarget {
	id: string;
	type: string;
	title: string;
	url: string;
	webSocketDebuggerUrl?: string;
}

export type FetchLike = (
	input: string,
	init?: { method?: string; signal?: AbortSignal },
) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}>;

const defaultFetch: FetchLike = (input, init) => fetch(input, init) as unknown as ReturnType<FetchLike>;

/** List inspectable Chrome targets via the DevTools HTTP endpoint. */
export async function listTargets(
	host: string,
	port: number,
	signal?: AbortSignal,
	fetchImpl: FetchLike = defaultFetch,
): Promise<CdpTarget[]> {
	let res: Awaited<ReturnType<FetchLike>>;
	try {
		res = await fetchImpl(`http://${host}:${port}/json`, { signal });
	} catch (err) {
		throw new Error(
			`Could not reach Chrome DevTools at ${host}:${port}. Start Chrome with ` +
				`--remote-debugging-port=${port} (and --user-data-dir=<dir>). (${(err as Error).message})`,
		);
	}
	if (!res.ok) throw new Error(`Chrome DevTools endpoint ${host}:${port} returned HTTP ${res.status}.`);
	const data = await res.json();
	return Array.isArray(data) ? (data as CdpTarget[]) : [];
}

/** Open a new tab/page in the running Chrome via the DevTools HTTP endpoint. */
export async function createTarget(
	host: string,
	port: number,
	url: string,
	signal?: AbortSignal,
	fetchImpl: FetchLike = defaultFetch,
): Promise<CdpTarget> {
	const endpoint = `http://${host}:${port}/json/new?${encodeURIComponent(url)}`;
	// Chrome 111+ requires PUT; older builds accept GET. Try PUT, fall back to GET.
	let res = await fetchImpl(endpoint, { method: "PUT", signal });
	if (!res.ok && (res.status === 405 || res.status === 501)) {
		res = await fetchImpl(endpoint, { method: "GET", signal });
	}
	if (!res.ok) throw new Error(`Could not open a new tab (HTTP ${res.status}).`);
	const target = (await res.json()) as CdpTarget;
	if (!target?.webSocketDebuggerUrl) throw new Error("New tab is missing a webSocketDebuggerUrl.");
	return target;
}

// ---------------------------------------------------------------------------
// WebSocket transport (WHATWG event API), injectable for tests.
// ---------------------------------------------------------------------------

export interface WebSocketLike {
	send(data: string): void;
	close(): void;
	addEventListener(type: string, listener: (ev: { data?: unknown }) => void): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const defaultWsFactory: WebSocketFactory = (url) =>
	new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url);

interface PendingCall {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export class CdpConnection {
	private readonly url: string;
	private readonly wsFactory: WebSocketFactory;
	private ws: WebSocketLike | undefined;
	private openPromise: Promise<void> | undefined;
	private nextId = 1;
	private closed = false;
	private readonly pending = new Map<number, PendingCall>();
	private readonly listeners = new Map<string, Set<(params: any) => void>>();

	constructor(url: string, wsFactory: WebSocketFactory = defaultWsFactory) {
		this.url = url;
		this.wsFactory = wsFactory;
	}

	private ensureOpen(): Promise<void> {
		if (this.openPromise) return this.openPromise;
		this.openPromise = new Promise<void>((resolve, reject) => {
			let opened = false;
			const ws = this.wsFactory(this.url);
			this.ws = ws;
			ws.addEventListener("open", () => {
				opened = true;
				resolve();
			});
			ws.addEventListener("error", () => {
				if (!opened) reject(new Error(`WebSocket error connecting to ${this.url}`));
				this.failAll(new Error("CDP socket error"));
			});
			ws.addEventListener("close", () => {
				this.closed = true;
				if (!opened) reject(new Error(`WebSocket closed before opening: ${this.url}`));
				this.failAll(new Error("CDP socket closed"));
			});
			ws.addEventListener("message", (ev) => {
				this.onMessage(typeof ev.data === "string" ? ev.data : String(ev.data ?? ""));
			});
		});
		return this.openPromise;
	}

	/** Send a CDP command and await its result. */
	async send(
		method: string,
		params: Record<string, unknown> = {},
		opts?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<any> {
		if (this.closed) throw new Error("CDP connection is closed.");
		await this.ensureOpen();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP command ${method} timed out`));
			}, opts?.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
			const onAbort = () => {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(new Error(`CDP command ${method} aborted`));
			};
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			this.pending.set(id, { resolve, reject, timer });
			this.ws?.send(JSON.stringify({ id, method, params }));
		});
	}

	/** Subscribe to a CDP event (e.g. "Network.responseReceived"). Returns an unsubscribe fn. */
	on(eventMethod: string, handler: (params: any) => void): () => void {
		const set = this.listeners.get(eventMethod) ?? new Set();
		set.add(handler);
		this.listeners.set(eventMethod, set);
		return () => set.delete(handler);
	}

	/**
	 * True once the socket closed (locally via close() or remotely via the WS
	 * close/error path). A closed connection never recovers — callers should
	 * drop it and open a fresh one (the manager evicts on this flag).
	 */
	isClosed(): boolean {
		return this.closed;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		try {
			this.ws?.close();
		} catch {
			// ignore
		}
		this.failAll(new Error("CDP connection closed"));
	}

	private onMessage(raw: string): void {
		let msg: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown };
		try {
			msg = JSON.parse(raw);
		} catch {
			return;
		}
		if (typeof msg.id === "number") {
			const call = this.pending.get(msg.id);
			if (!call) return;
			clearTimeout(call.timer);
			this.pending.delete(msg.id);
			if (msg.error) call.reject(new Error(msg.error.message ?? "CDP error"));
			else call.resolve(msg.result);
		} else if (msg.method) {
			const set = this.listeners.get(msg.method);
			if (set) for (const handler of set) handler(msg.params);
		}
	}

	private failAll(err: Error): void {
		for (const [, call] of this.pending) {
			clearTimeout(call.timer);
			call.reject(err);
		}
		this.pending.clear();
	}
}
