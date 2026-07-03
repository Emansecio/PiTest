/**
 * Tests for the configurable MCP startup connect budget (`mcp.connectTimeoutMs`)
 * and the one-line session notice emitted when a server is skipped for exceeding
 * that budget. Drives createMcpExtension against a real McpManager backed by a
 * mocked MCP-over-HTTP server whose handshake can be delayed and aborted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../src/core/built-ins/mcp-extension.js";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.js";
import { setCurrentToolDiscoveryIndex } from "../src/core/tool-discovery.js";

/** Per-URL view of a mocked MCP server. */
interface FakeServer {
	tools: Array<{ name: string }>;
	/** Delay (ms) applied to every request before it answers; honors abort. */
	delayMs: number;
}

function installMcpFetch(serversByUrl: Record<string, FakeServer>) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const server = serversByUrl[url];
		if (!server) throw new Error(`unexpected url ${url}`);
		// Stall the handshake so a small connect budget aborts it mid-flight. The
		// transport forwards its abort signal, so an aborted boot rejects promptly.
		if (server.delayMs > 0) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, server.delayMs);
				init?.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("aborted"));
					},
					{ once: true },
				);
			});
		}
		const body = init?.body ? JSON.parse(init.body.toString()) : {};
		if (body.method === "notifications/initialized") {
			return new Response("", { status: 200, headers: { "content-type": "application/json" } });
		}
		let result: unknown;
		if (body.method === "initialize") {
			result = { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } };
		} else if (body.method === "tools/list") {
			result = {
				tools: server.tools.map((t) => ({ name: t.name, description: "", inputSchema: { type: "object" } })),
			};
		} else if (body.method === "tools/call") {
			result = { content: [{ type: "text", text: "ok" }] };
		} else {
			throw new Error(`unexpected method ${body.method}`);
		}
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	(globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
	return fetchMock;
}

async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 1500;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	expect(check()).toBe(true);
}

interface CapturedMessage {
	customType: string;
	content: string;
	display?: boolean;
}

/** Minimal in-memory ExtensionAPI capturing tools, active tools, and sent messages. */
function createFakePi() {
	const registeredTools = new Map<string, ToolDefinition>();
	let activeTools: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const sentMessages: CapturedMessage[] = [];

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
		registerTool(tool: ToolDefinition) {
			registeredTools.set(tool.name, tool);
		},
		registerCommand() {},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = names;
		},
		sendMessage(message: CapturedMessage) {
			sentMessages.push(message);
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		registeredTools,
		sentMessages,
		fireSessionStart: () => handlers.get("session_start")?.({ type: "session_start" }, {}),
		fireSessionShutdown: () => handlers.get("session_shutdown")?.({ type: "session_shutdown" }, {}),
	};
}

describe("MCP startup connect budget (mcp.connectTimeoutMs)", () => {
	const originalFetch = globalThis.fetch;
	const SLOW_URL = "http://localhost:0/slow";

	beforeEach(() => {
		setCurrentToolDiscoveryIndex(undefined);
		delete process.env.PIT_DRY_RUN;
	});
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("skips a server that misses the budget and emits a one-line notice", async () => {
		installMcpFetch({ [SLOW_URL]: { delayMs: 60_000, tools: [{ name: "ping" }] } });
		const harness = createFakePi();
		createMcpExtension({ settings: { connectTimeoutMs: 20, servers: { slow: { url: SLOW_URL } } } })(harness.pi);
		await harness.fireSessionStart();

		await waitFor(() => harness.sentMessages.some((m) => m.customType === "mcp.notice"));

		const notice = harness.sentMessages.find((m) => m.customType === "mcp.notice");
		expect(notice).toBeDefined();
		// Compact wording: names the server, rounds the sub-second budget up to 1s,
		// points at /mcp, and drops the old url / "startup budget" / connectTimeoutMs noise.
		expect(notice?.content).toContain(`"slow"`);
		expect(notice?.content).toContain("did not connect within 1s");
		expect(notice?.content).toContain("/mcp");
		expect(notice?.content).not.toContain(SLOW_URL);
		expect(notice?.content).not.toContain("startup budget");
		expect(notice?.content).not.toContain("connectTimeoutMs");
		expect(notice?.display).toBe(true);
		// The slow server never registered any tools (it was skipped).
		expect(harness.registeredTools.has("mcp__slow__ping")).toBe(false);

		harness.fireSessionShutdown();
	});

	it("aggregates multiple skipped servers into a single notice", async () => {
		const SLOW_URL_B = "http://localhost:0/slow-b";
		installMcpFetch({
			[SLOW_URL]: { delayMs: 60_000, tools: [{ name: "ping" }] },
			[SLOW_URL_B]: { delayMs: 60_000, tools: [{ name: "pong" }] },
		});
		const harness = createFakePi();
		createMcpExtension({
			settings: { connectTimeoutMs: 20, servers: { slow: { url: SLOW_URL }, slowB: { url: SLOW_URL_B } } },
		})(harness.pi);
		await harness.fireSessionStart();

		await waitFor(() => harness.sentMessages.some((m) => m.customType === "mcp.notice"));

		const notices = harness.sentMessages.filter((m) => m.customType === "mcp.notice");
		// One aggregated line — not one card per server.
		expect(notices).toHaveLength(1);
		const content = notices[0].content;
		expect(content).toContain("2 servers waiting for on-demand connect");
		expect(content).toContain("slow");
		expect(content).toContain("slowB");
		expect(content).toContain("/mcp");
		expect(notices[0].display).toBe(true);

		harness.fireSessionShutdown();
	});

	it("respects a budget large enough for the server to connect (no skip notice)", async () => {
		installMcpFetch({ [SLOW_URL]: { delayMs: 40, tools: [{ name: "ping" }] } });
		const harness = createFakePi();
		createMcpExtension({ settings: { connectTimeoutMs: 2000, servers: { slow: { url: SLOW_URL } } } })(harness.pi);
		await harness.fireSessionStart();

		await waitFor(() => harness.registeredTools.has("mcp__slow__ping"));

		// Connected within the raised budget: tool registered, no skip notice fired.
		expect(harness.registeredTools.has("mcp__slow__ping")).toBe(true);
		expect(harness.sentMessages.some((m) => m.customType === "mcp.notice")).toBe(false);

		harness.fireSessionShutdown();
	});
});
