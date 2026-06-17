/**
 * Wiring tests for MCP resources + prompts (Phase 3): a connected server that
 * advertises the resources/prompts capabilities must get the two native resource
 * tools registered and each prompt exposed as a slash command that injects the
 * server-rendered text as a user message.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpExtension } from "../src/core/built-ins/mcp-extension.js";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.js";

const URL = "http://localhost:0/full";

function installFetch() {
	(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
		async (_input: string | URL | Request, init?: RequestInit) => {
			const body = init?.body ? JSON.parse(init.body.toString()) : {};
			if (body.method === "notifications/initialized") {
				return new Response("", { status: 200, headers: { "content-type": "application/json" } });
			}
			let result: unknown;
			switch (body.method) {
				case "initialize":
					result = {
						protocolVersion: "2025-06-18",
						serverInfo: { name: "full" },
						capabilities: { tools: {}, resources: {}, prompts: {} },
					};
					break;
				case "tools/list":
					result = { tools: [] };
					break;
				case "resources/list":
					result = { resources: [{ uri: "file://a.txt", name: "A", description: "the A file" }] };
					break;
				case "resources/read":
					result = { contents: [{ uri: body.params.uri, text: "hello-resource" }] };
					break;
				case "prompts/list":
					result = {
						prompts: [
							{ name: "greet", description: "greet someone", arguments: [{ name: "who", required: true }] },
						],
					};
					break;
				case "prompts/get":
					result = {
						messages: [{ role: "user", content: { type: "text", text: `Hello ${body.params.arguments.who}` } }],
					};
					break;
				default:
					throw new Error(`unexpected method ${body.method}`);
			}
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	) as unknown as typeof fetch;
}

function createFakePi() {
	const registeredTools = new Map<string, ToolDefinition>();
	const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const userMessages: string[] = [];
	let activeTools: string[] = [];
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
			handlers.set(event, handler);
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
		sendUserMessage(content: string) {
			userMessages.push(content);
		},
	} as unknown as ExtensionAPI;
	return {
		pi,
		registeredTools,
		userMessages,
		getActiveTools: () => activeTools,
		fireSessionStart: () => handlers.get("session_start")?.({ type: "session_start" }, {}),
		runCommand: (name: string, args: string) => commands.get(name)?.(args, { hasUI: false }),
		fireBeforeAgentStart: (prompt: string) =>
			handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt }, {}) as Promise<
				{ message?: { content: string } } | undefined
			>,
	};
}

describe("MCP resources + prompts wiring", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("registers resource tools and reads a resource", async () => {
		installFetch();
		const harness = createFakePi();
		createMcpExtension({ settings: { servers: { full: { url: URL } } } })(harness.pi);
		await harness.fireSessionStart();

		expect(harness.registeredTools.has("list_mcp_resources")).toBe(true);
		expect(harness.registeredTools.has("read_mcp_resource")).toBe(true);
		expect(harness.getActiveTools()).toEqual(expect.arrayContaining(["list_mcp_resources", "read_mcp_resource"]));

		const readTool = harness.registeredTools.get("read_mcp_resource")!;
		const res = await readTool.execute(
			"id1",
			{ server: "full", uri: "file://a.txt" },
			undefined,
			undefined as never,
			undefined as never,
		);
		expect(res.content[0]).toEqual({ type: "text", text: "[file://a.txt]\nhello-resource" });

		const listTool = harness.registeredTools.get("list_mcp_resources")!;
		const listed = await listTool.execute("id2", {}, undefined, undefined as never, undefined as never);
		expect((listed.content[0] as { text: string }).text).toContain("file://a.txt");
	});

	it("registers each prompt as a slash command that injects the rendered text", async () => {
		installFetch();
		const harness = createFakePi();
		createMcpExtension({ settings: { servers: { full: { url: URL } } } })(harness.pi);
		await harness.fireSessionStart();

		await harness.runCommand("mcp__full__greet", "world");
		expect(harness.userMessages).toEqual(["Hello world"]);
	});

	it("expands @server:uri mentions in the prompt into a resource context message", async () => {
		installFetch();
		const harness = createFakePi();
		createMcpExtension({ settings: { servers: { full: { url: URL } } } })(harness.pi);
		await harness.fireSessionStart();

		const result = await harness.fireBeforeAgentStart("look at @full:file://a.txt please");
		expect(result?.message?.content).toContain("[@full:file://a.txt]");
		expect(result?.message?.content).toContain("hello-resource");
	});

	it("leaves a mention for an unknown server untouched (no expansion)", async () => {
		installFetch();
		const harness = createFakePi();
		createMcpExtension({ settings: { servers: { full: { url: URL } } } })(harness.pi);
		await harness.fireSessionStart();

		const result = await harness.fireBeforeAgentStart("ping @someone:hello on slack");
		expect(result).toBeUndefined();
	});
});
