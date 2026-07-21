/**
 * Tests for McpHttpClient via an in-process fetch mock. The mock simulates a
 * compliant JSON-RPC MCP server: initialize → tools/list → tools/call.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { McpHttpClient } from "../src/core/mcp/client.js";
import { McpManager } from "../src/core/mcp/manager.js";

const TEST_URL = "http://localhost:0/mcp";

type Handler = (body: { method: string; params?: Record<string, unknown> }) => unknown;

function installFetch(handlerByUrl: Record<string, Handler>) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const handler = handlerByUrl[url];
		if (!handler) throw new Error(`unexpected url ${url}`);
		const body = init?.body ? JSON.parse(init.body.toString()) : {};
		if (body.method === "notifications/initialized") {
			return new Response("", { status: 200, headers: { "content-type": "application/json" } });
		}
		const result = handler(body);
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

describe("McpHttpClient", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("initializes, lists tools, and calls a tool", async () => {
		installFetch({
			[TEST_URL]: (body) => {
				if (body.method === "initialize") {
					return { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } };
				}
				if (body.method === "tools/list") {
					return { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] };
				}
				if (body.method === "tools/call") {
					return { content: [{ type: "text", text: "pong" }] };
				}
				throw new Error(`unexpected method ${body.method}`);
			},
		});
		const client = new McpHttpClient("test", { url: TEST_URL });
		await client.initialize();
		expect(client.getTools().map((t) => t.name)).toEqual(["ping"]);
		const result = await client.callTool("ping", {});
		expect(result.content[0]).toEqual({ type: "text", text: "pong" });
	});

	it("follows tools/list pagination across pages via nextCursor", async () => {
		const pages: Record<string, { tools: Array<{ name: string }>; nextCursor?: string }> = {
			"": { tools: [{ name: "a" }], nextCursor: "p1" },
			p1: { tools: [{ name: "b" }], nextCursor: "p2" },
			p2: { tools: [{ name: "c" }] }, // no cursor → last page
		};
		const listCalls: Array<unknown> = [];
		installFetch({
			[TEST_URL]: (body) => {
				if (body.method === "initialize") {
					return { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } };
				}
				if (body.method === "tools/list") {
					const cursor = (body.params?.cursor as string | undefined) ?? "";
					listCalls.push(body.params ?? {});
					const page = pages[cursor];
					return {
						tools: page.tools.map((t) => ({ ...t, description: "", inputSchema: { type: "object" } })),
						...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
					};
				}
				throw new Error(`unexpected method ${body.method}`);
			},
		});
		const client = new McpHttpClient("test", { url: TEST_URL });
		await client.initialize();
		expect(client.getTools().map((t) => t.name)).toEqual(["a", "b", "c"]);
		// First page sends no cursor; subsequent pages echo the prior nextCursor.
		expect(listCalls).toEqual([{}, { cursor: "p1" }, { cursor: "p2" }]);
	});

	it("stops paginating tools/list if a server repeats a cursor (no forward progress)", async () => {
		let listCount = 0;
		installFetch({
			[TEST_URL]: (body) => {
				if (body.method === "initialize") {
					return { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } };
				}
				if (body.method === "tools/list") {
					listCount++;
					// Always returns the SAME cursor → would loop forever unguarded.
					return {
						tools: [{ name: `t${listCount}`, description: "", inputSchema: { type: "object" } }],
						nextCursor: "stuck",
					};
				}
				throw new Error(`unexpected method ${body.method}`);
			},
		});
		const client = new McpHttpClient("test", { url: TEST_URL });
		await client.initialize();
		// Page 1 sets the cursor; page 2 sees it repeat and breaks.
		expect(listCount).toBe(2);
		expect(client.getTools().map((t) => t.name)).toEqual(["t1", "t2"]);
	});

	it("throws on JSON-RPC error response", async () => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "boom" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as typeof fetch;
		const client = new McpHttpClient("x", { url: TEST_URL });
		await expect(client.initialize()).rejects.toThrow("boom");
	});

	it("aborts a hung initialize via the external signal (boot budget)", async () => {
		// Simulate a server that accepts the request but never responds: the
		// fetch promise only settles when the (internal) signal aborts, which the
		// external signal triggers through the rpc abort listener.
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(new DOMException("This operation was aborted", "AbortError"));
					});
				}),
		) as unknown as typeof fetch;
		const client = new McpHttpClient("hung", { url: TEST_URL });
		const startedAt = Date.now();
		await expect(client.initialize(AbortSignal.timeout(100))).rejects.toThrow();
		// Must fail on the external budget, not the 15s handshake timeout.
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("dispose cancels config commands before they can start a transport", async () => {
		const fetchMock = installFetch({
			[TEST_URL]: () => ({ protocolVersion: "2025-06-18", capabilities: {} }),
		});
		const nodePath = process.execPath.replaceAll("\\", "/");
		const slowHeader = `!"${nodePath}" -e "setTimeout(()=>process.stdout.write('token'), 1000)"`;
		const client = new McpHttpClient("disposing", {
			url: TEST_URL,
			headers: { Authorization: slowHeader },
		});

		const startedAt = Date.now();
		const initialization = client.initialize();
		await new Promise((resolve) => setTimeout(resolve, 50));
		client.dispose();

		await expect(initialization).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(800);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("aborts a body that stalls after the headers (external signal must reach the body read)", async () => {
		// Server sends headers immediately but never delivers the JSON body.
		// Regression: cleanup used to run in the fetch `finally`, detaching the
		// outer-abort forwarding before response.json() — the stalled body then
		// hung forever and the user's abort could no longer cancel it.
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) => {
				const body = new ReadableStream({
					start(controller) {
						init?.signal?.addEventListener("abort", () => {
							controller.error(new DOMException("This operation was aborted", "AbortError"));
						});
					},
				});
				return Promise.resolve(
					new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
				);
			},
		) as unknown as typeof fetch;
		const client = new McpHttpClient("stalled-body", { url: TEST_URL });
		const startedAt = Date.now();
		await expect(client.initialize(AbortSignal.timeout(100))).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("times out a tools/call whose body stalls after the headers (internal timer covers the body read)", async () => {
		const stallOn = "tools/call";
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			(_input: string | URL | Request, init?: RequestInit) => {
				const parsed = init?.body ? JSON.parse(init.body.toString()) : {};
				if (parsed.method === "notifications/initialized") {
					return Promise.resolve(
						new Response("", { status: 200, headers: { "content-type": "application/json" } }),
					);
				}
				if (parsed.method !== stallOn) {
					const result =
						parsed.method === "initialize"
							? { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } }
							: { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] };
					return Promise.resolve(
						new Response(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }), {
							status: 200,
							headers: { "content-type": "application/json" },
						}),
					);
				}
				const body = new ReadableStream({
					start(controller) {
						init?.signal?.addEventListener("abort", () => {
							controller.error(new DOMException("This operation was aborted", "AbortError"));
						});
					},
				});
				return Promise.resolve(
					new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
				);
			},
		) as unknown as typeof fetch;
		const client = new McpHttpClient("stalled-call", { url: TEST_URL, timeoutMs: 100 });
		await client.initialize();
		const startedAt = Date.now();
		await expect(client.callTool("ping", {})).rejects.toThrow();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("parses a Streamable-HTTP SSE response (event: message) carrying the JSON-RPC result", async () => {
		// Modern Streamable HTTP servers may answer a POST with text/event-stream
		// instead of application/json. The transport must read the SSE frame whose
		// JSON-RPC id matches the request and return it (no longer a hard reject).
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body.toString()) : {};
				if (body.method === "notifications/initialized") {
					return new Response("", { status: 200, headers: { "content-type": "application/json" } });
				}
				const result =
					body.method === "initialize"
						? {
								protocolVersion: "2025-06-18",
								serverInfo: { name: "test", version: "1" },
								capabilities: { tools: {} },
							}
						: body.method === "tools/list"
							? { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] }
							: { content: [{ type: "text", text: "pong" }] };
				const frame = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n`;
				return new Response(frame, { status: 200, headers: { "content-type": "text/event-stream" } });
			},
		) as unknown as typeof fetch;
		const client = new McpHttpClient("sse-http", { url: TEST_URL });
		await client.initialize();
		expect(client.getTools().map((t) => t.name)).toEqual(["ping"]);
		const result = await client.callTool("ping", {});
		expect(result.content[0]).toEqual({ type: "text", text: "pong" });
	});

	it("rejects a response whose Content-Length exceeds the cap without reading the body", async () => {
		// Declares a 100MB body via Content-Length. The guard must reject up front;
		// the body itself must never be read (readBody would throw if touched).
		let bodyRead = false;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
			const headers = new Headers({
				"content-type": "application/json",
				"content-length": String(100 * 1024 * 1024),
			});
			const resp = new Response("{}", { status: 200, headers });
			Object.defineProperty(resp, "text", {
				value: () => {
					bodyRead = true;
					throw new Error("body should not be read when Content-Length exceeds cap");
				},
			});
			Object.defineProperty(resp, "json", {
				value: () => {
					bodyRead = true;
					throw new Error("body should not be read when Content-Length exceeds cap");
				},
			});
			return resp;
		}) as unknown as typeof fetch;
		const client = new McpHttpClient("big", { url: TEST_URL });
		await expect(client.initialize()).rejects.toThrow("MCP response too large");
		expect(bodyRead).toBe(false);
	});

	it("aborts and rejects a chunked response that streams past the cap (no Content-Length)", async () => {
		// No Content-Length → guard must cap the stream read. Emits 1MB chunks
		// without end; once the accumulated size crosses the cap it cancels the
		// body and rejects. `cancel()` resolves the stream so the test terminates.
		let cancelled = false;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
			const oneMb = new Uint8Array(1024 * 1024);
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					// Endless 1MB chunks; the reader cap stops us well before OOM.
					controller.enqueue(oneMb);
				},
				cancel() {
					cancelled = true;
				},
			});
			// No content-length header → forces the streaming cap path.
			return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		const client = new McpHttpClient("flood", { url: TEST_URL });
		await expect(client.initialize()).rejects.toThrow("MCP response too large");
		expect(cancelled).toBe(true);
	});

	it("parses a normal (under-cap) response identically through the capped reader", async () => {
		// Behavior-preservation: a small body must parse to the exact same result.
		installFetch({
			[TEST_URL]: (body) => {
				if (body.method === "initialize") {
					return { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } };
				}
				if (body.method === "tools/list") {
					return { tools: [{ name: "ping", description: "ping", inputSchema: { type: "object" } }] };
				}
				if (body.method === "tools/call") {
					return { content: [{ type: "text", text: "pong" }] };
				}
				throw new Error(`unexpected method ${body.method}`);
			},
		});
		const client = new McpHttpClient("normal", { url: TEST_URL });
		await client.initialize();
		expect(client.getTools().map((t) => t.name)).toEqual(["ping"]);
		const result = await client.callTool("ping", {});
		expect(result.content[0]).toEqual({ type: "text", text: "pong" });
	});

	it("captures Mcp-Session-Id from initialize and echoes it on every later request", async () => {
		const SID = "sess-abc-123";
		const sentSessionIds: Array<string | null> = [];
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url !== TEST_URL) throw new Error(`unexpected url ${url}`);
				sentSessionIds.push(new Headers(init?.headers).get("mcp-session-id"));
				const body = init?.body ? JSON.parse(init.body.toString()) : {};
				// Only the initialize response carries the session id (spec behavior).
				const headers: Record<string, string> = { "content-type": "application/json" };
				if (body.method === "initialize") headers["mcp-session-id"] = SID;
				if (body.method === "notifications/initialized") {
					return new Response("", { status: 200, headers });
				}
				let result: unknown;
				if (body.method === "initialize") {
					result = { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } };
				} else if (body.method === "tools/list") {
					result = { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] };
				} else if (body.method === "tools/call") {
					result = { content: [{ type: "text", text: "pong" }] };
				} else {
					throw new Error(`unexpected method ${body.method}`);
				}
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers });
			},
		) as unknown as typeof fetch;

		const client = new McpHttpClient("test", { url: TEST_URL });
		await client.initialize();
		await client.callTool("ping", {});

		// First request (initialize) carries no session id yet; every request after
		// the server assigned one must echo it (notifications/initialized, tools/list
		// during initialize, and the later tools/call).
		expect(sentSessionIds[0]).toBeNull();
		expect(sentSessionIds.length).toBeGreaterThanOrEqual(4);
		expect(sentSessionIds.slice(1)).toEqual(sentSessionIds.slice(1).map(() => SID));
	});

	it("drops the session id on dispose so a reconnect re-handshakes", async () => {
		const SID = "sess-xyz";
		const sentSessionIds: Array<string | null> = [];
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url !== TEST_URL) throw new Error(`unexpected url ${url}`);
				sentSessionIds.push(new Headers(init?.headers).get("mcp-session-id"));
				const body = init?.body ? JSON.parse(init.body.toString()) : {};
				const headers: Record<string, string> = { "content-type": "application/json" };
				if (body.method === "initialize") headers["mcp-session-id"] = SID;
				if (body.method === "notifications/initialized") return new Response("", { status: 200, headers });
				const result =
					body.method === "initialize"
						? { protocolVersion: "2025-06-18", serverInfo: { name: "t" } }
						: { tools: [] };
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers });
			},
		) as unknown as typeof fetch;

		const client = new McpHttpClient("test", { url: TEST_URL });
		await client.initialize();
		client.dispose();
		sentSessionIds.length = 0;
		await client.initialize();
		// After dispose the first request of the fresh handshake carries no stale id.
		expect(sentSessionIds[0]).toBeNull();
	});

	it("clears a stale session id when initialize re-runs without dispose (lazy reconnect)", async () => {
		// The lazy reconnect path reuses the SAME client instance and calls
		// initialize() again WITHOUT dispose(). The fresh handshake must not echo
		// the dead id; the server (e.g. after a restart) hands out a new one.
		const sentSessionIds: Array<string | null> = [];
		let handshakes = 0;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url !== TEST_URL) throw new Error(`unexpected url ${url}`);
				sentSessionIds.push(new Headers(init?.headers).get("mcp-session-id"));
				const body = init?.body ? JSON.parse(init.body.toString()) : {};
				const headers: Record<string, string> = { "content-type": "application/json" };
				// Each initialize hands out a distinct id: "sess-1" then "sess-2".
				if (body.method === "initialize") {
					handshakes++;
					headers["mcp-session-id"] = `sess-${handshakes}`;
				}
				if (body.method === "notifications/initialized") return new Response("", { status: 200, headers });
				const result =
					body.method === "initialize"
						? { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } }
						: body.method === "tools/list"
							? { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] }
							: { content: [{ type: "text", text: "pong" }] };
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), { status: 200, headers });
			},
		) as unknown as typeof fetch;

		const client = new McpHttpClient("test", { url: TEST_URL });

		// First handshake: server assigns sess-1; the next call must echo sess-1.
		await client.initialize();
		sentSessionIds.length = 0;
		await client.callTool("ping", {});
		expect(sentSessionIds).toEqual(["sess-1"]);

		// Reconnect WITHOUT dispose: the second initialize must NOT carry the stale
		// sess-1. The server then assigns sess-2, which later calls must echo.
		sentSessionIds.length = 0;
		await client.initialize();
		expect(sentSessionIds[0]).toBeNull();
		sentSessionIds.length = 0;
		await client.callTool("ping", {});
		expect(sentSessionIds).toEqual(["sess-2"]);
	});
});

describe("McpManager", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("connects all servers and exposes prefixed tools", async () => {
		installFetch({
			[TEST_URL]: (body) => {
				if (body.method === "initialize") return { protocolVersion: "1", serverInfo: { name: "test" } };
				if (body.method === "tools/list")
					return { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] };
				if (body.method === "tools/call") return { content: [{ type: "text", text: "ok" }] };
				throw new Error("unexpected");
			},
		});
		const manager = new McpManager({ servers: { test: { url: TEST_URL } } });
		await manager.connectAll();
		const tools = manager.listTools();
		expect(tools.map((t) => t.prefixedName)).toEqual(["mcp__test__ping"]);
		const result = await manager.callTool("mcp__test__ping", {});
		expect(result.content[0]).toEqual({ type: "text", text: "ok" });
	});

	it("records lastError on failure", async () => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async () => {
			throw new Error("net down");
		}) as typeof fetch;
		const manager = new McpManager({ servers: { x: { url: TEST_URL } } });
		await manager.connectAll();
		const state = manager.getState("x")!;
		expect(state.connected).toBe(false);
		expect(state.lastError).toContain("net down");
	});
});

describe("McpManager callTool recovery", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	// Programmable counting mock: tracks calls per JSON-RPC method and lets a
	// test override tools/call behavior per invocation (throw = network-level
	// transport failure, JSON-RPC error object = application failure).
	function installRecoveryFetch(onToolsCall: (invocation: number) => unknown) {
		const counts = { initialize: 0, toolsList: 0, toolsCall: 0 };
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				// Mirror real fetch: a pre-aborted signal rejects immediately.
				if (init?.signal?.aborted) {
					throw new DOMException("This operation was aborted", "AbortError");
				}
				const body = init?.body ? JSON.parse(init.body.toString()) : {};
				const respond = (payload: Record<string, unknown>) =>
					new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				if (body.method === "notifications/initialized") {
					return new Response("", { status: 200, headers: { "content-type": "application/json" } });
				}
				if (body.method === "initialize") {
					counts.initialize++;
					return respond({ result: { protocolVersion: "1", serverInfo: { name: "test" } } });
				}
				if (body.method === "tools/list") {
					counts.toolsList++;
					return respond({
						result: { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] },
					});
				}
				if (body.method === "tools/call") {
					counts.toolsCall++;
					const outcome = onToolsCall(counts.toolsCall);
					if (outcome instanceof Error) throw outcome;
					return respond(outcome as Record<string, unknown>);
				}
				throw new Error(`unexpected method ${body.method}`);
			},
		) as unknown as typeof fetch;
		return counts;
	}

	it("keeps the server connected and never re-sends the call on a JSON-RPC application error", async () => {
		const counts = installRecoveryFetch(() => ({ error: { code: -1, message: "boom" } }));
		const manager = new McpManager({ servers: { test: { url: TEST_URL } } });
		await manager.connectAll();
		await expect(manager.callTool("mcp__test__ping", {})).rejects.toThrow("boom");
		expect(counts.toolsCall).toBe(1);
		expect(counts.initialize).toBe(1); // boot only — no reconnect for app errors
		const state = manager.getState("test")!;
		expect(state.connected).toBe(true);
		expect(state.lastError).toContain("boom");
	});

	it("re-initializes after a transport failure but never re-sends the call", async () => {
		const counts = installRecoveryFetch(() => new Error("socket hang up"));
		const manager = new McpManager({ servers: { test: { url: TEST_URL } } });
		await manager.connectAll();
		await expect(manager.callTool("mcp__test__ping", {})).rejects.toThrow("socket hang up");
		expect(counts.toolsCall).toBe(1); // the failed call is NOT retried
		expect(counts.initialize).toBe(2); // boot + reconnect-for-next-call
		const state = manager.getState("test")!;
		expect(state.connected).toBe(true); // reconnect succeeded
		expect(state.reconnectAttempts).toBe(0); // reset by the successful reconnect
	});

	it("a direct success resets a degraded entry back to healthy", async () => {
		let failInitialize = false;
		const counts = { initialize: 0, toolsCall: 0 };
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const body = init?.body ? JSON.parse(init.body.toString()) : {};
				const respond = (payload: Record<string, unknown>) =>
					new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, ...payload }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				if (body.method === "notifications/initialized") {
					return new Response("", { status: 200, headers: { "content-type": "application/json" } });
				}
				if (body.method === "initialize") {
					counts.initialize++;
					if (failInitialize) throw new Error("still down");
					return respond({ result: { protocolVersion: "1", serverInfo: { name: "test" } } });
				}
				if (body.method === "tools/list") {
					return respond({
						result: { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] },
					});
				}
				if (body.method === "tools/call") {
					counts.toolsCall++;
					if (counts.toolsCall === 1) throw new Error("blip");
					return respond({ result: { content: [{ type: "text", text: "pong" }] } });
				}
				throw new Error(`unexpected method ${body.method}`);
			},
		) as unknown as typeof fetch;

		const manager = new McpManager({ servers: { test: { url: TEST_URL } } });
		await manager.connectAll();

		// First call: transport failure AND the reconnect attempt fails too.
		failInitialize = true;
		await expect(manager.callTool("mcp__test__ping", {})).rejects.toThrow("blip");
		let state = manager.getState("test")!;
		expect(state.connected).toBe(false);
		expect(state.reconnectAttempts).toBe(1);

		// Second call: server is back; a plain success must clear the degraded state.
		failInitialize = false;
		const result = await manager.callTool("mcp__test__ping", {});
		expect(result.content[0]).toEqual({ type: "text", text: "pong" });
		state = manager.getState("test")!;
		expect(state.connected).toBe(true);
		expect(state.reconnectAttempts).toBe(0);
		expect(state.lastError).toBeUndefined();
	});

	it("a user abort leaves connection state untouched", async () => {
		const controller = new AbortController();
		const counts = installRecoveryFetch(() => {
			// Abort mid-call, as a user cancel does, then fail like an aborted fetch.
			controller.abort();
			throw new DOMException("This operation was aborted", "AbortError");
		});
		const manager = new McpManager({ servers: { test: { url: TEST_URL } } });
		await manager.connectAll();
		await expect(manager.callTool("mcp__test__ping", {}, controller.signal)).rejects.toThrow();
		expect(counts.initialize).toBe(1); // no reconnect triggered by the abort
		const state = manager.getState("test")!;
		expect(state.connected).toBe(true);
		expect(state.lastError).toBeUndefined();
	});
});

describe("McpManager enable / disable / reconnect", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	const pingServer = (): Record<string, Handler> => ({
		[TEST_URL]: (body) => {
			if (body.method === "initialize") return { protocolVersion: "1", serverInfo: { name: "test" } };
			if (body.method === "tools/list")
				return { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] };
			if (body.method === "tools/call") return { content: [{ type: "text", text: "ok" }] };
			throw new Error("unexpected");
		},
	});

	it("lists a disabled server but never connects it", async () => {
		installFetch(pingServer());
		const manager = new McpManager({ servers: { test: { url: TEST_URL, disabled: true } } });
		await manager.connectAll();
		const state = manager.getState("test")!;
		expect(state.disabled).toBe(true);
		expect(state.connected).toBe(false);
		expect(manager.listTools()).toEqual([]);
	});

	it("enable connects a disabled server; disable tears it down", async () => {
		installFetch(pingServer());
		const manager = new McpManager({ servers: { test: { url: TEST_URL, disabled: true } } });
		await manager.connectAll();
		expect(manager.getState("test")!.connected).toBe(false);

		const enabled = await manager.enable("test");
		expect(enabled!.disabled).toBe(false);
		expect(enabled!.connected).toBe(true);
		expect(manager.listTools().map((t) => t.prefixedName)).toEqual(["mcp__test__ping"]);

		const disabled = manager.disable("test");
		expect(disabled!.disabled).toBe(true);
		expect(disabled!.connected).toBe(false);
		expect(disabled!.tools).toEqual([]);
		expect(manager.listTools()).toEqual([]);
	});

	it("reconnect re-handshakes a server that failed at boot", async () => {
		let up = false;
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async (_input, init?: RequestInit) => {
			if (!up) throw new Error("net down");
			const body = init?.body ? JSON.parse(init.body.toString()) : {};
			if (body.method === "notifications/initialized") {
				return new Response("", { status: 200, headers: { "content-type": "application/json" } });
			}
			const result = pingServer()[TEST_URL](body);
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof fetch;

		const manager = new McpManager({ servers: { test: { url: TEST_URL } } });
		await manager.connectAll();
		expect(manager.getState("test")!.connected).toBe(false);

		up = true;
		const state = await manager.reconnect("test");
		expect(state!.connected).toBe(true);
		expect(state!.lastError).toBeUndefined();
		expect(manager.listTools().map((t) => t.prefixedName)).toEqual(["mcp__test__ping"]);
	});
});
