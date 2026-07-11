/**
 * xAI Grok OAuth (SuperGrok / X Premium+)
 *
 * Reuses the public Grok-CLI OAuth client_id — xAI rejects loopback OAuth from
 * non-allowlisted clients. Same approach as OpenCode's xai plugin and the
 * official `grok` CLI (`~/.grok/auth.json`).
 *
 * Two login paths (picked via onSelect):
 * - Browser PKCE → http://127.0.0.1:56121/callback (pinned port; Grok-CLI registration)
 * - RFC 8628 device-code (headless / SSH / VPS)
 */

let _http: typeof import("node:http") | null = null;
if (typeof process !== "undefined" && (process.versions?.node || process.versions?.bun)) {
	import("node:http").then((m) => {
		_http = m;
	});
}

import type { Api, Model } from "../../types.ts";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.ts";

/** Public Grok-CLI client — must match xAI's allowlist for loopback redirects. */
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

const AUTHORIZE_URL = "https://auth.x.ai/oauth2/authorize";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code";
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

const OAUTH_HOST = "127.0.0.1";
const OAUTH_PORT = 56121;
const OAUTH_REDIRECT_PATH = "/callback";
const REDIRECT_URI = `http://${OAUTH_HOST}:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`;

const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000;
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;
/** Hard timeout for every xAI OAuth fetch (compose with caller signal when present). */
const XAI_FETCH_TIMEOUT_MS = 30_000;

function xaiFetchSignal(caller?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(XAI_FETCH_TIMEOUT_MS);
	return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/** Public console / Chat Completions API (Grok 4.5, API keys, SuperGrok OAuth). */
const XAI_API_BASE = "https://api.x.ai/v1";
/** Grok CLI subscription proxy — hosts Composer 2.5 and the same OAuth session models. */
const XAI_CLI_PROXY_BASE = "https://cli-chat-proxy.grok.com/v1";

type TokenSuccess = { type: "success"; access: string; refresh: string; expires: number };
type TokenFailure = { type: "failed"; message: string };
type TokenResult = TokenSuccess | TokenFailure;

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
}

export interface DeviceCodeResponse {
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete?: string;
	expires_in?: number;
	interval?: number;
}

function authHeaders(): Record<string, string> {
	return {
		"Content-Type": "application/x-www-form-urlencoded",
		Accept: "application/json",
		"User-Agent": "pit/xai-oauth",
	};
}

function createState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function parseCallbackTimeoutMs(): number {
	const raw = process.env.PIT_OAUTH_CALLBACK_TIMEOUT_MS;
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return 5 * 60 * 1000;
}

function positiveSecondsToMs(value: unknown, defaultMs: number): number {
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs;
}

function tokensToCredentials(tokens: TokenResponse, previousRefresh?: string): OAuthCredentials {
	const refresh = tokens.refresh_token ?? previousRefresh;
	if (!tokens.access_token || !refresh) {
		throw new Error("xAI token response missing access_token or refresh_token");
	}
	const expiresIn = typeof tokens.expires_in === "number" && tokens.expires_in > 0 ? tokens.expires_in : 3600;
	return {
		access: tokens.access_token,
		refresh,
		expires: Date.now() + expiresIn * 1000,
	};
}

export function buildXaiAuthorizeUrl(pkce: { challenge: string }, state: string, nonce: string): string {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: XAI_OAUTH_CLIENT_ID,
		redirect_uri: REDIRECT_URI,
		scope: SCOPE,
		code_challenge: pkce.challenge,
		code_challenge_method: "S256",
		state,
		nonce,
		plan: "generic",
		referrer: "pit",
	});
	return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeAuthorizationCode(code: string, verifier: string, signal?: AbortSignal): Promise<TokenResult> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: authHeaders(),
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code,
			redirect_uri: REDIRECT_URI,
			client_id: XAI_OAUTH_CLIENT_ID,
			code_verifier: verifier,
		}).toString(),
		signal: xaiFetchSignal(signal),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		return {
			type: "failed",
			message: `xAI token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`,
		};
	}
	const tokens = (await response.json()) as TokenResponse;
	try {
		return { type: "success", ...tokensToCredentials(tokens) };
	} catch (error) {
		return { type: "failed", message: error instanceof Error ? error.message : String(error) };
	}
}

async function refreshAccessToken(refreshToken: string, signal?: AbortSignal): Promise<TokenResult> {
	const response = await fetch(TOKEN_URL, {
		method: "POST",
		headers: authHeaders(),
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: refreshToken,
			client_id: XAI_OAUTH_CLIENT_ID,
		}).toString(),
		signal: xaiFetchSignal(signal),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		return { type: "failed", message: `xAI token refresh failed (${response.status})${detail ? `: ${detail}` : ""}` };
	}
	const tokens = (await response.json()) as TokenResponse;
	try {
		return { type: "success", ...tokensToCredentials(tokens, refreshToken) };
	} catch (error) {
		return { type: "failed", message: error instanceof Error ? error.message : String(error) };
	}
}

export async function requestXaiDeviceCode(signal?: AbortSignal): Promise<DeviceCodeResponse> {
	const response = await fetch(DEVICE_AUTHORIZATION_URL, {
		method: "POST",
		headers: authHeaders(),
		body: new URLSearchParams({
			client_id: XAI_OAUTH_CLIENT_ID,
			scope: SCOPE,
		}).toString(),
		signal: xaiFetchSignal(signal),
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(`xAI device code request failed (${response.status})${detail ? `: ${detail}` : ""}`);
	}
	const json = (await response.json()) as DeviceCodeResponse;
	if (!json.device_code || !json.user_code || !json.verification_uri) {
		throw new Error("xAI device code response is missing device_code / user_code / verification_uri");
	}
	return json;
}

export async function pollXaiDeviceCodeToken(
	device: DeviceCodeResponse,
	options: { sleep?: (ms: number) => Promise<void>; now?: () => number; signal?: AbortSignal } = {},
): Promise<OAuthCredentials> {
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = options.now ?? (() => Date.now());
	const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS);
	const deadline = now() + expiresInMs;
	let intervalMs = Math.max(
		positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
		DEVICE_CODE_MIN_INTERVAL_MS,
	);

	while (now() < deadline) {
		if (options.signal?.aborted) throw new Error("Login cancelled");
		const response = await fetch(TOKEN_URL, {
			method: "POST",
			headers: authHeaders(),
			body: new URLSearchParams({
				grant_type: DEVICE_CODE_GRANT_TYPE,
				client_id: XAI_OAUTH_CLIENT_ID,
				device_code: device.device_code,
			}).toString(),
			signal: xaiFetchSignal(options.signal),
		});
		if (response.ok) {
			const tokens = (await response.json()) as TokenResponse;
			return tokensToCredentials(tokens);
		}
		const body = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
		const remaining = Math.max(0, deadline - now());
		if (body.error === "authorization_pending") {
			await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
			continue;
		}
		if (body.error === "slow_down") {
			intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS;
			await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining));
			continue;
		}
		if (body.error === "access_denied" || body.error === "authorization_denied") {
			throw new Error("xAI device authorization was denied");
		}
		if (body.error === "expired_token") {
			throw new Error("xAI device code expired — please re-run /login");
		}
		const detail = body.error_description ?? body.error ?? "";
		throw new Error(`xAI device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`);
	}
	throw new Error("xAI device authorization timed out");
}

function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};
	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		/* not a URL */
	}
	if (value.includes("code=")) {
		const params = new URLSearchParams(value.startsWith("http") ? new URL(value).search : value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}
	return { code: value };
}

type OAuthServerInfo = {
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string } | null>;
	close: () => void;
};

async function startLocalOAuthServer(expectedState: string): Promise<OAuthServerInfo> {
	if (!_http) {
		await new Promise((r) => setTimeout(r, 50));
	}
	if (!_http) {
		throw new Error("xAI OAuth is only available in Node.js environments");
	}

	let settle: ((value: { code: string } | null) => void) | undefined;
	const waitForCode = new Promise<{ code: string } | null>((resolve) => {
		settle = resolve;
	});

	const server = _http.createServer((req, res) => {
		try {
			const url = new URL(req.url ?? "/", `http://${OAUTH_HOST}:${OAUTH_PORT}`);
			if (url.pathname !== OAUTH_REDIRECT_PATH) {
				res.writeHead(404);
				res.end("Not found");
				return;
			}
			const error = url.searchParams.get("error");
			if (error) {
				const desc = url.searchParams.get("error_description") ?? error;
				res.writeHead(200, { "Content-Type": "text/html" });
				res.end(oauthErrorHtml(desc));
				settle?.(null);
				settle = undefined;
				return;
			}
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			if (!code) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(oauthErrorHtml("Missing authorization code"));
				settle?.(null);
				settle = undefined;
				return;
			}
			if (state !== expectedState) {
				res.writeHead(400, { "Content-Type": "text/html" });
				res.end(oauthErrorHtml("Invalid state — potential CSRF"));
				settle?.(null);
				settle = undefined;
				return;
			}
			res.writeHead(200, { "Content-Type": "text/html" });
			res.end(oauthSuccessHtml("You can close this window and return to Pit."));
			settle?.({ code });
			settle = undefined;
		} catch (error) {
			res.writeHead(500, { "Content-Type": "text/html" });
			res.end(oauthErrorHtml(error instanceof Error ? error.message : String(error)));
			settle?.(null);
			settle = undefined;
		}
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error) => {
			reject(err);
		};
		server.once("error", onError);
		server.listen(OAUTH_PORT, OAUTH_HOST, () => {
			server.removeListener("error", onError);
			resolve();
		});
	});

	return {
		redirectUri: REDIRECT_URI,
		cancelWait: () => {
			settle?.(null);
			settle = undefined;
		},
		waitForCode: () => waitForCode,
		close: () => {
			server.close();
		},
	};
}

async function waitForCallbackBounded(
	server: OAuthServerInfo,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ code: string } | null> {
	if (signal?.aborted) {
		server.cancelWait();
		return server.waitForCode();
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => server.cancelWait();
	try {
		if (timeoutMs > 0 && timeoutMs !== Number.POSITIVE_INFINITY) {
			timer = setTimeout(() => server.cancelWait(), timeoutMs);
			timer.unref?.();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		return await server.waitForCode();
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function loginXaiBrowser(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const state = createState();
	const nonce = createState();
	const url = buildXaiAuthorizeUrl(pkce, state, nonce);

	let server: OAuthServerInfo;
	try {
		server = await startLocalOAuthServer(state);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Could not bind ${REDIRECT_URI} (${detail}). Close the Grok CLI if it is running, or choose device-code login.`,
		);
	}

	callbacks.onAuth({
		url,
		instructions: "Complete authorization in your browser. This window will close automatically.",
	});

	try {
		const callbackTimeoutMs = parseCallbackTimeoutMs();
		const manualPromise = callbacks.onManualCodeInput?.() ?? new Promise<string>(() => {});
		const callbackPromise = waitForCallbackBounded(server, callbacks.signal, callbackTimeoutMs);

		const winner = await Promise.race([
			callbackPromise.then((r) => ({ source: "callback" as const, result: r })),
			manualPromise.then((input) => ({ source: "manual" as const, input })),
		]);

		let code: string | undefined;
		if (winner.source === "callback") {
			code = winner.result?.code;
			if (!code && callbacks.onPrompt) {
				callbacks.onProgress?.("Browser callback timed out — paste the redirect URL instead.");
				const input = await callbacks.onPrompt({
					message: "Paste the redirect URL (or authorization code):",
					placeholder: REDIRECT_URI,
				});
				const parsed = parseAuthorizationInput(input);
				if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
				code = parsed.code;
			}
		} else {
			server.cancelWait();
			const parsed = parseAuthorizationInput(winner.input);
			if (parsed.state && parsed.state !== state) throw new Error("State mismatch");
			code = parsed.code;
		}

		if (!code) throw new Error("Missing authorization code");
		if (callbacks.signal?.aborted) throw new Error("Login cancelled");

		const tokenResult = await exchangeAuthorizationCode(code, pkce.verifier, callbacks.signal);
		if (tokenResult.type !== "success") throw new Error(tokenResult.message);
		return {
			access: tokenResult.access,
			refresh: tokenResult.refresh,
			expires: tokenResult.expires,
		};
	} finally {
		server.close();
	}
}

async function loginXaiDevice(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	callbacks.onProgress?.("Requesting device code from xAI…");
	const device = await requestXaiDeviceCode(callbacks.signal);
	const browserUrl = device.verification_uri_complete ?? device.verification_uri;
	callbacks.onAuth({
		url: browserUrl,
		instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
	});
	callbacks.onProgress?.("Waiting for authorization…");
	return pollXaiDeviceCodeToken(device, { signal: callbacks.signal });
}

/**
 * Models available under SuperGrok / X Premium+ (and XAI_API_KEY for grok-4.5).
 * IDs match the Grok CLI catalog (`~/.grok/models_cache.json`) and docs.x.ai.
 * - grok-4.5: frontier (Jul 2026), aliases grok-4.5-latest / grok-build-latest
 * - grok-composer-2.5-fast: Cursor Composer 2.5 via Grok CLI proxy
 */
export const XAI_OAUTH_MODELS: Model<Api>[] = [
	{
		id: "grok-4.5",
		name: "Grok 4.5",
		api: "openai-completions",
		provider: "xai",
		baseUrl: XAI_API_BASE,
		reasoning: true,
		// Grok 4.5 reasoning_effort: low | medium | high (docs.x.ai). off/minimal/xhigh unsupported.
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null },
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 64_000,
	},
	{
		id: "grok-composer-2.5-fast",
		name: "Composer 2.5",
		api: "openai-completions",
		provider: "xai",
		baseUrl: XAI_CLI_PROXY_BASE,
		// Grok CLI catalog marks supports_reasoning_effort=false; force on so Pit
		// sends reasoning_effort (low/medium/high) — proxy may honor it anyway.
		reasoning: true,
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	},
	{
		id: "grok-build-0.1",
		name: "Grok Build 0.1",
		api: "openai-completions",
		provider: "xai",
		baseUrl: XAI_API_BASE,
		reasoning: true,
		// Same effort vocabulary as grok-4.5 until xAI documents otherwise.
		thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 64_000,
	},
];

export async function loginXai(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	let method = "browser";
	if (callbacks.onSelect) {
		const selected = await callbacks.onSelect({
			message: "xAI Grok sign-in method:",
			options: [
				{ id: "browser", label: "Browser (SuperGrok / X Premium+)" },
				{ id: "device", label: "Device code (headless / SSH / VPS)" },
			],
		});
		if (!selected) throw new Error("Login cancelled");
		method = selected;
	}
	if (method === "device") return loginXaiDevice(callbacks);
	return loginXaiBrowser(callbacks);
}

export async function refreshXaiToken(refreshToken: string, signal?: AbortSignal): Promise<OAuthCredentials> {
	const result = await refreshAccessToken(refreshToken, signal);
	if (result.type !== "success") throw new Error(result.message);
	return {
		access: result.access,
		refresh: result.refresh,
		expires: result.expires,
	};
}

export const xaiOAuthProvider: OAuthProviderInterface = {
	id: "xai",
	name: "xAI Grok (SuperGrok / X Premium+)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginXai(callbacks);
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshXaiToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},

	modifyModels(models: Model<Api>[]): Model<Api>[] {
		const withoutXai = models.filter((m) => m.provider !== "xai");
		return [...withoutXai, ...XAI_OAUTH_MODELS.map((m) => ({ ...m }))];
	},
};
