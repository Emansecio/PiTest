/**
 * Wire test for the legacy HTTP+SSE transport: a long-lived GET event channel
 * delivers an `endpoint` event then carries JSON-RPC responses, while requests
 * go out as POSTs to the advertised endpoint. Exercises endpoint discovery,
 * id-correlated responses over the channel, and `transport: "sse"` inference.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/core/mcp/client.js";

const GET_URL = "http://localhost:0/sse";
const POST_URL = "http://localhost:0/messages";

describe("SseTransport (legacy HTTP+SSE)", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("discovers the endpoint, then correlates responses delivered on the GET channel", async () => {
		const encoder = new TextEncoder();
		let channel: ReadableStreamDefaultController<Uint8Array> | undefined;
		const pushFrame = (obj: unknown) =>
			channel?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(obj)}\n\n`));

		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				const method = (init?.method ?? "GET").toUpperCase();

				if (method === "GET" && url === GET_URL) {
					const body = new ReadableStream<Uint8Array>({
						start(controller) {
							channel = controller;
							// Advertise the POST endpoint immediately.
							controller.enqueue(encoder.encode(`event: endpoint\ndata: /messages\n\n`));
						},
					});
					return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
				}

				if (method === "POST" && url === POST_URL) {
					const rpc = init?.body ? JSON.parse(init.body.toString()) : {};
					// Notifications get a bare 202 and no channel response.
					if (rpc.method === "notifications/initialized") return new Response("", { status: 202 });
					let result: unknown;
					if (rpc.method === "initialize") {
						result = { protocolVersion: "1", serverInfo: { name: "sse" }, capabilities: { tools: {} } };
					} else if (rpc.method === "tools/list") {
						result = { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] };
					} else if (rpc.method === "tools/call") {
						result = { content: [{ type: "text", text: "pong" }] };
					}
					// Deliver the response asynchronously over the GET channel (202 here).
					queueMicrotask(() => pushFrame({ jsonrpc: "2.0", id: rpc.id, result }));
					return new Response("", { status: 202 });
				}
				throw new Error(`unexpected ${method} ${url}`);
			},
		) as unknown as typeof fetch;

		const client = new McpClient("legacy", { transport: "sse", url: GET_URL });
		await client.initialize(AbortSignal.timeout(10_000));
		expect(client.getTools().map((t) => t.name)).toEqual(["ping"]);
		const result = await client.callTool("ping", {});
		expect(result.content[0]).toEqual({ type: "text", text: "pong" });
		client.dispose();
	});
});
