/**
 * Tests for the MCP deferral policy: which servers' tools are kept off the
 * active surface (registered into the tool-discovery index, found on demand via
 * search_tool_bm25) vs registered eagerly. Deferral keeps grab-bag servers from
 * permanently bloating the prompt and churning the cache prefix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension, shouldDeferMcpServer } from "../src/core/built-ins/mcp-extension.js";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.js";
import type { McpServerConfig, McpSettings } from "../src/core/mcp/index.js";
import {
	createToolDiscoveryIndex,
	setCurrentToolDiscoveryIndex,
	type ToolDiscoveryIndex,
} from "../src/core/tool-discovery.js";

describe("shouldDeferMcpServer", () => {
	const originalEnv = process.env.PIT_DEFER_MCP;
	beforeEach(() => {
		delete process.env.PIT_DEFER_MCP;
	});
	afterEach(() => {
		if (originalEnv === undefined) delete process.env.PIT_DEFER_MCP;
		else process.env.PIT_DEFER_MCP = originalEnv;
	});

	const noServer: McpServerConfig | undefined = undefined;

	it("auto (default) defers only servers at or above the threshold", () => {
		const settings: McpSettings = {}; // defer defaults to "auto", threshold 10
		expect(shouldDeferMcpServer(25, noServer, settings)).toBe(true); // Chrome/DC-sized
		expect(shouldDeferMcpServer(10, noServer, settings)).toBe(true); // exactly at threshold
		expect(shouldDeferMcpServer(9, noServer, settings)).toBe(false); // just under
		expect(shouldDeferMcpServer(2, noServer, settings)).toBe(false); // small focused server
	});

	it("auto honors a custom deferThreshold", () => {
		const settings: McpSettings = { defer: "auto", deferThreshold: 5 };
		expect(shouldDeferMcpServer(5, noServer, settings)).toBe(true);
		expect(shouldDeferMcpServer(4, noServer, settings)).toBe(false);
	});

	it("always defers every server regardless of size", () => {
		const settings: McpSettings = { defer: "always" };
		expect(shouldDeferMcpServer(1, noServer, settings)).toBe(true);
		expect(shouldDeferMcpServer(50, noServer, settings)).toBe(true);
	});

	it("never defers any server (legacy eager behavior)", () => {
		const settings: McpSettings = { defer: "never" };
		expect(shouldDeferMcpServer(50, noServer, settings)).toBe(false);
	});

	it("per-server defer override wins over the global policy", () => {
		// Force-eager a big server even under auto.
		expect(shouldDeferMcpServer(40, { url: "x", defer: false }, {})).toBe(false);
		// Force-defer a tiny server even under "never".
		expect(shouldDeferMcpServer(1, { url: "x", defer: true }, { defer: "never" })).toBe(true);
	});

	it("legacy PIT_DEFER_MCP=1 forces always, but a per-server override still wins", () => {
		process.env.PIT_DEFER_MCP = "1";
		expect(shouldDeferMcpServer(1, noServer, { defer: "never" })).toBe(true); // env beats global
		expect(shouldDeferMcpServer(40, { url: "x", defer: false }, {})).toBe(false); // server beats env
	});
});

// ---------------------------------------------------------------------------
// Registration wiring: drives createMcpExtension against a real McpManager
// (backed by a mocked MCP-over-HTTP server) to assert what lands eagerly on the
// active surface vs into the discovery index, that deferred tools are indexed
// with their parameter names as tags, and that a server which missed the boot
// connect budget still gets its tools registered when it comes up later.
// ---------------------------------------------------------------------------

interface ToolSpec {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** Per-URL view of a mocked MCP server: its tool list and whether it answers. */
interface FakeServer {
	tools: ToolSpec[];
	/** When false, every request to this URL rejects like a dead socket. */
	up: boolean;
}

function installMcpFetch(serversByUrl: Record<string, FakeServer>) {
	const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const server = serversByUrl[url];
		if (!server) throw new Error(`unexpected url ${url}`);
		if (!server.up) throw new Error("socket hang up");
		const body = init?.body ? JSON.parse(init.body.toString()) : {};
		if (body.method === "notifications/initialized") {
			return new Response("", { status: 200, headers: { "content-type": "application/json" } });
		}
		let result: unknown;
		if (body.method === "initialize") {
			result = { protocolVersion: "2025-06-18", serverInfo: { name: "test", version: "1" } };
		} else if (body.method === "tools/list") {
			result = {
				tools: server.tools.map((t) => ({
					name: t.name,
					description: t.description ?? "",
					inputSchema: t.inputSchema ?? { type: "object" },
				})),
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

async function waitForMcpEffect(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	expect(check()).toBe(true);
}

/** Minimal in-memory ExtensionAPI capturing exactly what the MCP extension uses. */
function createFakePi() {
	const registeredTools = new Map<string, ToolDefinition>();
	let activeTools: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();

	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
		},
		markSideEffect<F>(handler: F): F {
			return handler;
		},
		markMessageInjector<F>(handler: F): F {
			return handler;
		},
		registerTool(tool: ToolDefinition) {
			registeredTools.set(tool.name, tool);
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, options.handler);
		},
		getActiveTools() {
			return activeTools;
		},
		setActiveTools(names: string[]) {
			activeTools = names;
		},
	} as unknown as ExtensionAPI;

	return {
		pi,
		registeredTools,
		getActiveTools: () => activeTools,
		fireSessionStart: () => handlers.get("session_start")?.({ type: "session_start" }, {}),
		fireSessionShutdown: () => handlers.get("session_shutdown")?.({ type: "session_shutdown" }, {}),
		runCommand: (name: string) => commands.get(name)?.("", { hasUI: false }),
	};
}

describe("createMcpExtension registration wiring", () => {
	const originalFetch = globalThis.fetch;
	const SMALL_URL = "http://localhost:0/small";
	const BIG_URL = "http://localhost:0/big";

	let index: ToolDiscoveryIndex;
	beforeEach(() => {
		index = createToolDiscoveryIndex();
		setCurrentToolDiscoveryIndex(index);
	});
	afterEach(() => {
		setCurrentToolDiscoveryIndex(undefined);
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("registers a small server eagerly and defers a big server into the discovery index", async () => {
		installMcpFetch({
			[SMALL_URL]: { up: true, tools: [{ name: "ping" }, { name: "pong" }] },
			[BIG_URL]: {
				up: true,
				tools: Array.from({ length: 12 }, (_, i) => ({ name: `tool${i}` })),
			},
		});
		const harness = createFakePi();
		createMcpExtension({ settings: { servers: { small: { url: SMALL_URL }, big: { url: BIG_URL } } } })(harness.pi);
		await harness.fireSessionStart();
		await waitForMcpEffect(
			() =>
				harness.registeredTools.has("mcp__small__ping") &&
				index.listHidden().some((e) => e.name === "mcp__big__tool0"),
		);

		// Small server (2 tools < threshold 10): eager, on the registered surface.
		expect([...harness.registeredTools.keys()].sort()).toEqual(["mcp__small__ping", "mcp__small__pong"]);
		// Big server (12 tools >= 10): deferred into the index, NOT eagerly registered.
		const hidden = index.listHidden().map((e) => e.name);
		expect(hidden).toContain("mcp__big__tool0");
		expect(hidden).not.toContain("mcp__small__ping");
		// Deferral pulls search_tool_bm25 onto the active surface.
		expect(harness.getActiveTools()).toContain("search_tool_bm25");
	});

	it("indexes a deferred tool's parameter names as tags so BM25 can find it by argument", async () => {
		installMcpFetch({
			[BIG_URL]: {
				up: true,
				tools: [
					{
						name: "create_issue",
						description: "Create a record.",
						inputSchema: {
							type: "object",
							properties: {
								// A distinctive param name that does NOT appear in name/description:
								boomerang_priority: { type: "string", description: "urgency level" },
							},
						},
					},
					// Padding to push the server past the deferral threshold.
					...Array.from({ length: 11 }, (_, i) => ({ name: `pad${i}` })),
				],
			},
		});
		const harness = createFakePi();
		createMcpExtension({ settings: { servers: { big: { url: BIG_URL } } } })(harness.pi);
		await harness.fireSessionStart();
		await waitForMcpEffect(() => index.search("boomerang_priority")[0]?.entry.name === "mcp__big__create_issue");

		// The param name is captured as a tag and is searchable even though it is
		// absent from the tool's name and description (the dead promptSnippet check
		// would have left the doc as name+description only).
		const byParam = index.search("boomerang_priority");
		expect(byParam[0]?.entry.name).toBe("mcp__big__create_issue");
		// The per-property description is folded in as a tag too.
		const byPropDesc = index.search("urgency");
		expect(byPropDesc.some((r) => r.entry.name === "mcp__big__create_issue")).toBe(true);
	});

	it("registers tools for a server that missed the boot connect budget once it comes up", async () => {
		// `small` answers at boot; `late` is down during session_start (its connect
		// fails) so listTools skips it and no ToolDefinition exists for it.
		const servers = {
			[SMALL_URL]: { up: true, tools: [{ name: "ping" }] } as FakeServer,
			[BIG_URL]: { up: false, tools: [{ name: "later" }] } as FakeServer,
		};
		installMcpFetch(servers);
		const harness = createFakePi();
		createMcpExtension({ settings: { servers: { small: { url: SMALL_URL }, late: { url: BIG_URL } } } })(harness.pi);
		await harness.fireSessionStart();
		await waitForMcpEffect(() => harness.registeredTools.has("mcp__small__ping"));

		// Only the boot-connected server registered; the late one is toolless.
		expect([...harness.registeredTools.keys()]).toEqual(["mcp__small__ping"]);

		// The late server comes up; the on-demand /mcp retry reconnects and registers it.
		servers[BIG_URL].up = true;
		await harness.runCommand("mcp");
		expect([...harness.registeredTools.keys()].sort()).toEqual(["mcp__late__later", "mcp__small__ping"]);
	});

	it("leaves the active surface untouched for a boot-connected server with no deferral", async () => {
		installMcpFetch({ [SMALL_URL]: { up: true, tools: [{ name: "ping" }] } });
		const harness = createFakePi();
		createMcpExtension({ settings: { servers: { small: { url: SMALL_URL } } } })(harness.pi);
		await harness.fireSessionStart();
		await waitForMcpEffect(() => harness.registeredTools.has("mcp__small__ping"));
		// Nothing deferred → search_tool_bm25 is not force-activated (identical to prior behavior).
		expect(harness.getActiveTools()).not.toContain("search_tool_bm25");
		// A second /mcp with no disconnected servers must not re-register or churn.
		await harness.runCommand("mcp");
		expect([...harness.registeredTools.keys()]).toEqual(["mcp__small__ping"]);
	});
});
