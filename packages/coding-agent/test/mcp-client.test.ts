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

	it("rejects SSE responses with a clear error", async () => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async () => new Response("event: x\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
		) as typeof fetch;
		const client = new McpHttpClient("x", { url: TEST_URL });
		await expect(client.initialize()).rejects.toThrow("SSE transport not supported");
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
		expect(tools.map((t) => t.prefixedName)).toEqual(["test__ping"]);
		const result = await manager.callTool("test__ping", {});
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
