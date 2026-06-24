/**
 * OAuth 2.0 for remote (http/sse) MCP servers — browser authorization-code flow
 * with PKCE, matching `claude mcp` / the MCP auth spec. Discovery follows the
 * protected-resource (RFC 9728) → authorization-server (RFC 8414) metadata
 * chain; clients register dynamically (RFC 7591) when no client_id is configured.
 *
 * Tokens are stored per-server in `<agentDir>/mcp-auth.json`. The HTTP/SSE
 * transports attach `Authorization: Bearer <token>` (injected by McpClient), and
 * an expired token is refreshed before a reconnect.
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.ts";
import type { McpServerConfig } from "./types.ts";

export interface McpStoredToken {
	accessToken: string;
	refreshToken?: string;
	/** Epoch ms when the access token expires (best effort). */
	expiresAt?: number;
	tokenEndpoint?: string;
	clientId?: string;
	clientSecret?: string;
	scope?: string;
}

function authStorePath(agentDir: string): string {
	return join(agentDir, "mcp-auth.json");
}

function loadStore(agentDir: string): Record<string, McpStoredToken> {
	const path = authStorePath(agentDir);
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Record<string, McpStoredToken>;
	} catch {
		return {};
	}
}

function saveStore(agentDir: string, store: Record<string, McpStoredToken>): void {
	const path = authStorePath(agentDir);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
}

export function loadMcpToken(name: string, agentDir: string = getAgentDir()): McpStoredToken | undefined {
	return loadStore(agentDir)[name];
}

export function saveMcpToken(name: string, token: McpStoredToken, agentDir: string = getAgentDir()): void {
	const store = loadStore(agentDir);
	store[name] = token;
	saveStore(agentDir, store);
}

export function deleteMcpToken(name: string, agentDir: string = getAgentDir()): void {
	const store = loadStore(agentDir);
	if (store[name]) {
		delete store[name];
		saveStore(agentDir, store);
	}
}

/** A bit of slack so we refresh slightly before the hard expiry. */
const EXPIRY_SKEW_MS = 30_000;

export function isTokenExpired(token: McpStoredToken): boolean {
	return token.expiresAt !== undefined && Date.now() >= token.expiresAt - EXPIRY_SKEW_MS;
}

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
	const verifier = base64url(randomBytes(48));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Metadata discovery
// ---------------------------------------------------------------------------

interface AuthServerMetadata {
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint?: string;
	scopes_supported?: string[];
}

async function fetchJson(url: string): Promise<Record<string, unknown> | undefined> {
	try {
		const resp = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
		if (!resp.ok) return undefined;
		return (await resp.json()) as Record<string, unknown>;
	} catch {
		return undefined;
	}
}

/**
 * Resolve the authorization-server metadata for an MCP endpoint. Tries the
 * protected-resource metadata first (which points at the AS), then well-known AS
 * metadata at the MCP origin as a fallback.
 */
export async function discoverAuthServer(mcpUrl: string, explicitAsUrl?: string): Promise<AuthServerMetadata> {
	const origin = new URL(mcpUrl).origin;
	const asBases: string[] = [];
	if (explicitAsUrl) asBases.push(explicitAsUrl.replace(/\/$/, ""));

	const prm = await fetchJson(`${origin}/.well-known/oauth-protected-resource`);
	const authServers = prm?.authorization_servers;
	if (Array.isArray(authServers) && typeof authServers[0] === "string") {
		asBases.push((authServers[0] as string).replace(/\/$/, ""));
	}
	asBases.push(origin);

	for (const base of asBases) {
		for (const wellKnown of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
			const meta = await fetchJson(`${base}${wellKnown}`);
			if (meta && typeof meta.authorization_endpoint === "string" && typeof meta.token_endpoint === "string") {
				return {
					authorization_endpoint: meta.authorization_endpoint,
					token_endpoint: meta.token_endpoint,
					registration_endpoint:
						typeof meta.registration_endpoint === "string" ? meta.registration_endpoint : undefined,
					scopes_supported: Array.isArray(meta.scopes_supported) ? (meta.scopes_supported as string[]) : undefined,
				};
			}
		}
	}
	throw new Error(`Could not discover OAuth metadata for ${mcpUrl}`);
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------

async function registerClient(
	registrationEndpoint: string,
	redirectUri: string,
): Promise<{ clientId: string; clientSecret?: string }> {
	const resp = await fetch(registrationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({
			client_name: "Pit Coding Agent",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
		signal: AbortSignal.timeout(15_000),
	});
	if (!resp.ok) {
		throw new Error(
			`Dynamic client registration failed: HTTP ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 200)}`,
		);
	}
	const json = (await resp.json()) as { client_id?: string; client_secret?: string };
	if (!json.client_id) throw new Error("Dynamic client registration returned no client_id");
	return { clientId: json.client_id, clientSecret: json.client_secret };
}

// ---------------------------------------------------------------------------
// Browser + loopback callback
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
	const platform = process.platform;
	try {
		if (platform === "win32")
			spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
		else if (platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
	} catch {
		/* user can open the printed URL manually */
	}
}

/**
 * Start the one-shot loopback callback server. Resolves once it is listening with
 * the bound port and a promise that yields the auth code from the redirect. A
 * single server handles both the port reservation and the code capture, so the
 * redirect_uri the browser is sent to is exactly the one we listen on.
 */
function startCallbackServer(
	expectedState: string,
): Promise<{ port: number; code: Promise<string>; close: () => void }> {
	return new Promise((resolveStart, rejectStart) => {
		let resolveCode!: (code: string) => void;
		let rejectCode!: (err: Error) => void;
		const codePromise = new Promise<string>((res, rej) => {
			resolveCode = res;
			rejectCode = rej;
		});
		const server = createServer((req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			if (url.pathname !== "/callback") {
				res.writeHead(404).end("Not found");
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const error = url.searchParams.get("error");
			res.writeHead(200, { "content-type": "text/html" });
			if (error) {
				const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
				res.end(`<html><body><h3>Authorization failed: ${esc(error)}</h3>You can close this tab.</body></html>`);
				rejectCode(new Error(`Authorization error: ${error}`));
			} else if (!code || state !== expectedState) {
				res.end("<html><body><h3>Invalid callback.</h3>You can close this tab.</body></html>");
				rejectCode(new Error("Invalid OAuth callback (missing code or state mismatch)"));
			} else {
				res.end(
					"<html><body><h3>Authentication complete.</h3>You can close this tab and return to Pit.</body></html>",
				);
				resolveCode(code);
			}
		});
		const timeout = setTimeout(
			() => rejectCode(new Error("Timed out waiting for OAuth callback (5 min)")),
			5 * 60_000,
		);
		timeout.unref?.();
		const close = () => {
			clearTimeout(timeout);
			server.close();
		};
		server.on("error", (err) => {
			rejectStart(err);
			rejectCode(err);
		});
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			resolveStart({ port, code: codePromise, close });
		});
	});
}

async function exchangeToken(
	tokenEndpoint: string,
	params: Record<string, string>,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
	const resp = await fetch(tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(params).toString(),
		signal: AbortSignal.timeout(20_000),
	});
	if (!resp.ok) {
		throw new Error(`Token endpoint error: HTTP ${resp.status} ${(await resp.text().catch(() => "")).slice(0, 300)}`);
	}
	return (await resp.json()) as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
}

/** Run the full browser OAuth flow and persist the resulting token. */
export async function authenticateMcpServer(
	name: string,
	config: McpServerConfig,
	agentDir: string = getAgentDir(),
): Promise<McpStoredToken> {
	if (!config.url) throw new Error(`MCP server "${name}" has no url to authenticate against`);
	const meta = await discoverAuthServer(config.url, config.oauth?.authorizationServerUrl);

	const state = base64url(randomBytes(16));
	// Start the loopback server first so the redirect_uri matches the port we listen on.
	const callback = await startCallbackServer(state);
	// Use 127.0.0.1 on both ends: the loopback server binds 127.0.0.1, and 'localhost'
	// can resolve to ::1 (IPv6) first on dual-stack hosts -> browser hits a dead port.
	const redirectUri = `http://127.0.0.1:${callback.port}/callback`;

	let clientId: string;
	let clientSecret: string | undefined;
	let verifier: string;
	let scopes: string[] | undefined;
	let code: string;
	try {
		clientId = config.oauth?.clientId ?? "";
		clientSecret = config.oauth?.clientSecret;
		if (!clientId) {
			if (!meta.registration_endpoint) {
				throw new Error(`Server requires a client_id (no registration endpoint and no oauth.clientId configured)`);
			}
			const reg = await registerClient(meta.registration_endpoint, redirectUri);
			clientId = reg.clientId;
			clientSecret = reg.clientSecret;
		}

		const pkce = generatePkce();
		verifier = pkce.verifier;
		scopes = config.oauth?.scopes ?? meta.scopes_supported;
		const authUrl = new URL(meta.authorization_endpoint);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("client_id", clientId);
		authUrl.searchParams.set("redirect_uri", redirectUri);
		authUrl.searchParams.set("code_challenge", pkce.challenge);
		authUrl.searchParams.set("code_challenge_method", "S256");
		authUrl.searchParams.set("state", state);
		if (scopes && scopes.length > 0) authUrl.searchParams.set("scope", scopes.join(" "));

		console.log(`Opening browser to authorize "${name}":\n  ${authUrl.toString()}`);
		openBrowser(authUrl.toString());

		code = await callback.code;
	} finally {
		callback.close();
	}
	const tokenParams: Record<string, string> = {
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: clientId,
		code_verifier: verifier,
	};
	if (clientSecret) tokenParams.client_secret = clientSecret;
	const tokens = await exchangeToken(meta.token_endpoint, tokenParams);

	const stored: McpStoredToken = {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
		tokenEndpoint: meta.token_endpoint,
		clientId,
		clientSecret,
		scope: tokens.scope ?? scopes?.join(" "),
	};
	saveMcpToken(name, stored, agentDir);
	return stored;
}

/**
 * Refresh an expired token using its refresh_token. Returns the new token, or
 * undefined when no refresh is possible (caller should re-run authenticate).
 */
export async function refreshMcpToken(
	name: string,
	agentDir: string = getAgentDir(),
): Promise<McpStoredToken | undefined> {
	const token = loadMcpToken(name, agentDir);
	if (!token?.refreshToken || !token.tokenEndpoint || !token.clientId) return undefined;
	try {
		const params: Record<string, string> = {
			grant_type: "refresh_token",
			refresh_token: token.refreshToken,
			client_id: token.clientId,
		};
		if (token.clientSecret) params.client_secret = token.clientSecret;
		const tokens = await exchangeToken(token.tokenEndpoint, params);
		const updated: McpStoredToken = {
			...token,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token ?? token.refreshToken,
			expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
		};
		saveMcpToken(name, updated, agentDir);
		return updated;
	} catch {
		return undefined;
	}
}
