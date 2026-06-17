/**
 * Tests for the deterministic parts of MCP OAuth: PKCE generation, token store
 * (save/load/delete), expiry, refresh, and metadata discovery. The interactive
 * browser flow (authenticateMcpServer) is exercised end-to-end manually.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteMcpToken,
	discoverAuthServer,
	generatePkce,
	isTokenExpired,
	loadMcpToken,
	refreshMcpToken,
	saveMcpToken,
} from "../src/core/mcp/oauth.js";

function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("generatePkce", () => {
	it("produces a verifier and an S256 challenge derived from it", () => {
		const { verifier, challenge } = generatePkce();
		expect(verifier.length).toBeGreaterThan(40);
		expect(challenge).toBe(base64url(createHash("sha256").update(verifier).digest()));
	});
});

describe("token store", () => {
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pit-oauth-"));
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("saves, loads, and deletes a token", () => {
		expect(loadMcpToken("srv", agentDir)).toBeUndefined();
		saveMcpToken("srv", { accessToken: "tok", refreshToken: "ref" }, agentDir);
		expect(loadMcpToken("srv", agentDir)?.accessToken).toBe("tok");
		deleteMcpToken("srv", agentDir);
		expect(loadMcpToken("srv", agentDir)).toBeUndefined();
	});

	it("isTokenExpired honors expiresAt with skew", () => {
		expect(isTokenExpired({ accessToken: "x" })).toBe(false); // no expiry → never expired
		expect(isTokenExpired({ accessToken: "x", expiresAt: Date.now() + 60_000 })).toBe(false);
		expect(isTokenExpired({ accessToken: "x", expiresAt: Date.now() - 1 })).toBe(true);
	});
});

describe("refreshMcpToken", () => {
	const originalFetch = globalThis.fetch;
	let agentDir: string;
	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "pit-oauth-"));
	});
	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("exchanges the refresh token for a new access token", async () => {
		saveMcpToken(
			"srv",
			{ accessToken: "old", refreshToken: "ref", tokenEndpoint: "https://as/token", clientId: "cid" },
			agentDir,
		);
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ access_token: "new", refresh_token: "ref2", expires_in: 3600 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		) as typeof fetch;
		const refreshed = await refreshMcpToken("srv", agentDir);
		expect(refreshed?.accessToken).toBe("new");
		expect(refreshed?.refreshToken).toBe("ref2");
		expect(loadMcpToken("srv", agentDir)?.accessToken).toBe("new");
	});

	it("returns undefined when there is no refresh token", async () => {
		saveMcpToken("srv", { accessToken: "old" }, agentDir);
		expect(await refreshMcpToken("srv", agentDir)).toBeUndefined();
	});
});

describe("discoverAuthServer", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("follows protected-resource → authorization-server metadata", async () => {
		(globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.endsWith("/.well-known/oauth-protected-resource")) {
				return new Response(JSON.stringify({ authorization_servers: ["https://auth.example.com"] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (url === "https://auth.example.com/.well-known/oauth-authorization-server") {
				return new Response(
					JSON.stringify({
						authorization_endpoint: "https://auth.example.com/authorize",
						token_endpoint: "https://auth.example.com/token",
						registration_endpoint: "https://auth.example.com/register",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("not found", { status: 404 });
		}) as unknown as typeof fetch;

		const meta = await discoverAuthServer("https://mcp.example.com/sse");
		expect(meta.authorization_endpoint).toBe("https://auth.example.com/authorize");
		expect(meta.token_endpoint).toBe("https://auth.example.com/token");
		expect(meta.registration_endpoint).toBe("https://auth.example.com/register");
	});
});
