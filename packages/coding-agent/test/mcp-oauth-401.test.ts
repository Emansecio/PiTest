/**
 * The OAuth token is refreshed on a 401 even when the stored token had no
 * `expires_in` (so proactive refresh couldn't predict expiry). McpClient must
 * refresh and retry the same call once — a 401 is rejected at the auth gate, so
 * re-sending is safe.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpClient } from "../src/core/mcp/client.js";
import { saveMcpToken } from "../src/core/mcp/oauth.js";

const MCP_URL = "http://localhost:0/mcp";
const TOKEN_URL = "https://as.example/token";

describe("McpClient OAuth 401 refresh", () => {
	const originalFetch = globalThis.fetch;
	const prevAgentDir = process.env.PIT_CODING_AGENT_DIR;
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pit-oauth401-"));
		process.env.PIT_CODING_AGENT_DIR = agentDir;
	});
	afterEach(() => {
		if (prevAgentDir === undefined) delete process.env.PIT_CODING_AGENT_DIR;
		else process.env.PIT_CODING_AGENT_DIR = prevAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("refreshes on a 401 with no stored expiry and retries the call once", async () => {
		// Stored token WITHOUT expiresAt → proactive refresh can't fire.
		saveMcpToken(
			"srv",
			{ accessToken: "old", refreshToken: "ref", tokenEndpoint: TOKEN_URL, clientId: "cid" },
			agentDir,
		);

		let refreshed = false;
		const ok = (id: unknown, result: unknown) =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});

		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = typeof input === "string" ? input : input.toString();
				if (url === TOKEN_URL) {
					refreshed = true;
					return new Response(JSON.stringify({ access_token: "new", refresh_token: "ref2" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}
				const auth = new Headers(init?.headers).get("authorization");
				const body = init?.body ? JSON.parse(init.body.toString()) : {};
				if (body.method === "notifications/initialized") return new Response("", { status: 200 });
				if (body.method === "initialize")
					return ok(body.id, { protocolVersion: "1", serverInfo: { name: "s" }, capabilities: { tools: {} } });
				if (body.method === "tools/list")
					return ok(body.id, { tools: [{ name: "ping", description: "", inputSchema: { type: "object" } }] });
				if (body.method === "tools/call") {
					// Reject the stale bearer; accept the refreshed one.
					if (auth !== "Bearer new") {
						return new Response("unauthorized", { status: 401, headers: { "content-type": "text/plain" } });
					}
					return ok(body.id, { content: [{ type: "text", text: "pong" }] });
				}
				throw new Error(`unexpected ${body.method}`);
			},
		) as unknown as typeof fetch;

		const client = new McpClient("srv", { url: MCP_URL });
		await client.initialize();
		const result = await client.callTool("ping", {});
		expect(refreshed).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "pong" });
	});
});
