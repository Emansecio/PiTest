/**
 * Anthropic OAuth flow (Claude Pro/Max)
 *
 * NOTE: This module uses Node.js http.createServer for the OAuth callback server.
 * It is only intended for CLI use, not browser environments.
 */

import type { Server } from "node:http";
import { oauthErrorHtml, oauthSuccessHtml } from "./oauth-page.ts";
import { generatePKCE } from "./pkce.ts";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthPrompt, OAuthProviderInterface } from "./types.ts";

type CallbackServerInfo = {
	server: Server;
	redirectUri: string;
	cancelWait: () => void;
	waitForCode: () => Promise<{ code: string; state: string } | null>;
};

type NodeApis = {
	createServer: typeof import("node:http").createServer;
};

let nodeApis: NodeApis | null = null;
let nodeApisPromise: Promise<NodeApis> | null = null;

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CALLBACK_HOST = process.env.PIT_OAUTH_CALLBACK_HOST || "127.0.0.1";
const CALLBACK_PORT = 53692;
/**
 * Maximum time to block on the browser callback before falling through to the
 * manual `onPrompt` paste path. Without this bound, a callback that never
 * arrives (browser closed, login on a remote machine, etc.) would hang
 * `loginAnthropic` forever. Override via PIT_OAUTH_CALLBACK_TIMEOUT_MS.
 */
function parseCallbackTimeoutMs(): number {
	const raw = process.env.PIT_OAUTH_CALLBACK_TIMEOUT_MS;
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return 5 * 60 * 1000;
}
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
async function getNodeApis(): Promise<NodeApis> {
	if (nodeApis) return nodeApis;
	if (!nodeApisPromise) {
		if (typeof process === "undefined" || (!process.versions?.node && !process.versions?.bun)) {
			throw new Error("Anthropic OAuth is only available in Node.js environments");
		}
		nodeApisPromise = import("node:http").then((httpModule) => ({
			createServer: httpModule.createServer,
		}));
	}
	nodeApis = await nodeApisPromise;
	return nodeApis;
}

/**
 * Generate an independent random OAuth `state` (CSRF token), kept distinct from
 * the PKCE `code_verifier`. The verifier is a secret used only in the token
 * exchange; reusing it as `state` would leak it into the authorize URL and the
 * redirect (browser history, Referer, proxy logs), defeating PKCE.
 */
function createState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const byte of bytes) {
		hex += byte.toString(16).padStart(2, "0");
	}
	return hex;
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
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function startCallbackServer(expectedState: string): Promise<CallbackServerInfo> {
	const { createServer } = await getNodeApis();

	return new Promise((resolve, reject) => {
		let settleWait: ((value: { code: string; state: string } | null) => void) | undefined;
		const waitForCodePromise = new Promise<{ code: string; state: string } | null>((resolveWait) => {
			let settled = false;
			settleWait = (value) => {
				if (settled) return;
				settled = true;
				resolveWait(value);
			};
		});

		const server = createServer((req, res) => {
			try {
				const url = new URL(req.url || "", "http://localhost");
				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Callback route not found."));
					return;
				}

				const code = url.searchParams.get("code");
				const state = url.searchParams.get("state");
				const error = url.searchParams.get("error");

				if (error) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Anthropic authentication did not complete.", `Error: ${error}`));
					return;
				}

				if (!code || !state) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("Missing code or state parameter."));
					return;
				}

				if (state !== expectedState) {
					res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
					res.end(oauthErrorHtml("State mismatch."));
					return;
				}

				res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
				res.end(oauthSuccessHtml("Anthropic authentication completed. You can close this window."));
				settleWait?.({ code, state });
			} catch {
				res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
				res.end("Internal error");
			}
		});

		server.on("error", (err) => {
			reject(err);
		});

		server.listen(CALLBACK_PORT, CALLBACK_HOST, () => {
			resolve({
				server,
				redirectUri: REDIRECT_URI,
				cancelWait: () => {
					settleWait?.(null);
				},
				waitForCode: () => waitForCodePromise,
			});
		});
	});
}

/**
 * Wait for the OAuth callback, but bound the wait so a never-arriving redirect
 * (browser closed, remote-machine login, etc.) cannot hang forever. The wait
 * resolves early — to `null` — when `signal` aborts or the timeout elapses, in
 * which case the caller falls through to the manual paste path. All timers and
 * listeners are cleaned up regardless of which path wins.
 */
async function waitForCallbackBounded(
	server: CallbackServerInfo,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<{ code: string; state: string } | null> {
	if (signal?.aborted) {
		server.cancelWait();
		return server.waitForCode();
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const onAbort = () => {
		server.cancelWait();
	};

	try {
		if (timeoutMs > 0 && timeoutMs !== Number.POSITIVE_INFINITY) {
			timer = setTimeout(() => {
				server.cancelWait();
			}, timeoutMs);
			// Don't keep the process alive solely for this fallback timer.
			timer.unref?.();
		}
		signal?.addEventListener("abort", onAbort, { once: true });
		return await server.waitForCode();
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

async function postJson(url: string, body: Record<string, string | number>): Promise<string> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();

	if (!response.ok) {
		throw new Error(`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`);
	}

	return responseBody;
}

async function exchangeAuthorizationCode(
	code: string,
	state: string,
	verifier: string,
	redirectUri: string,
): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			state,
			redirect_uri: redirectUri,
			code_verifier: verifier,
		});
	} catch (error) {
		throw new Error(
			`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
		);
	}

	let tokenData: { access_token: string; refresh_token: string; expires_in: number };
	try {
		tokenData = JSON.parse(responseBody) as { access_token: string; refresh_token: string; expires_in: number };
	} catch (error) {
		throw new Error(
			`Token exchange returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		refresh: tokenData.refresh_token,
		access: tokenData.access_token,
		expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
	};
}

/**
 * Login with Anthropic OAuth (authorization code + PKCE)
 */
export async function loginAnthropic(options: {
	onAuth: (info: { url: string; instructions?: string }) => void;
	onPrompt: (prompt: OAuthPrompt) => Promise<string>;
	onProgress?: (message: string) => void;
	onManualCodeInput?: () => Promise<string>;
	signal?: AbortSignal;
}): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const expectedState = createState();
	const server = await startCallbackServer(expectedState);
	const callbackTimeoutMs = parseCallbackTimeoutMs();

	let code: string | undefined;
	let state: string | undefined;
	let redirectUriForExchange = REDIRECT_URI;

	try {
		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: REDIRECT_URI,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: expectedState,
		});

		options.onAuth({
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete login in your browser. If the browser is on another machine, paste the final redirect URL here.",
		});

		if (options.onManualCodeInput) {
			let manualInput: string | undefined;
			let manualError: Error | undefined;
			const manualPromise = options
				.onManualCodeInput()
				.then((input) => {
					manualInput = input;
					server.cancelWait();
				})
				.catch((err) => {
					manualError = err instanceof Error ? err : new Error(String(err));
					server.cancelWait();
				});

			// `signal` also unblocks here: without it an external abort while the
			// user neither pastes a code nor the browser redirect arrives would
			// hang on `waitForCode()`. The manual paste path already supplies its
			// own cancel via `cancelWait()`, so no timeout is forced here.
			const result = await waitForCallbackBounded(server, options.signal, Number.POSITIVE_INFINITY);

			if (manualError) {
				throw manualError;
			}

			if (result?.code) {
				code = result.code;
				state = result.state;
				redirectUriForExchange = REDIRECT_URI;
			} else if (manualInput) {
				const parsed = parseAuthorizationInput(manualInput);
				if (parsed.state && parsed.state !== expectedState) {
					throw new Error("OAuth state mismatch");
				}
				code = parsed.code;
				state = parsed.state ?? expectedState;
			}

			if (!code) {
				await manualPromise;
				if (manualError) {
					throw manualError;
				}
				if (manualInput) {
					const parsed = parseAuthorizationInput(manualInput);
					if (parsed.state && parsed.state !== expectedState) {
						throw new Error("OAuth state mismatch");
					}
					code = parsed.code;
					state = parsed.state ?? expectedState;
				}
			}
		} else {
			// Bound the callback wait: if the browser redirect never arrives
			// (window closed, remote-machine login, abort), fall through to the
			// manual `onPrompt` path instead of hanging forever.
			const result = await waitForCallbackBounded(server, options.signal, callbackTimeoutMs);
			if (result?.code) {
				code = result.code;
				state = result.state;
				redirectUriForExchange = REDIRECT_URI;
			}
		}

		if (!code) {
			const input = await options.onPrompt({
				message: "Paste the authorization code or full redirect URL:",
				placeholder: REDIRECT_URI,
			});
			const parsed = parseAuthorizationInput(input);
			if (parsed.state && parsed.state !== expectedState) {
				throw new Error("OAuth state mismatch");
			}
			code = parsed.code;
			state = parsed.state ?? expectedState;
		}

		if (!code) {
			throw new Error("Missing authorization code");
		}

		if (!state) {
			throw new Error("Missing OAuth state");
		}

		options.onProgress?.("Exchanging authorization code for tokens...");
		return exchangeAuthorizationCode(code, state, verifier, redirectUriForExchange);
	} finally {
		server.server.close();
	}
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(refreshToken: string): Promise<OAuthCredentials> {
	let responseBody: string;
	try {
		responseBody = await postJson(TOKEN_URL, {
			grant_type: "refresh_token",
			client_id: CLIENT_ID,
			refresh_token: refreshToken,
		});
	} catch (error) {
		throw new Error(`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`);
	}

	let data: { access_token: string; refresh_token: string; expires_in: number; scope?: string };
	try {
		data = JSON.parse(responseBody) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope?: string;
		};
	} catch (error) {
		throw new Error(
			`Anthropic token refresh returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
		);
	}

	return {
		refresh: data.refresh_token,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
	};
}

export const anthropicOAuthProvider: OAuthProviderInterface = {
	id: "anthropic",
	name: "Anthropic (Claude Pro/Max)",
	usesCallbackServer: true,

	async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
		return loginAnthropic({
			onAuth: callbacks.onAuth,
			onPrompt: callbacks.onPrompt,
			onProgress: callbacks.onProgress,
			onManualCodeInput: callbacks.onManualCodeInput,
			signal: callbacks.signal,
		});
	},

	async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
		return refreshAnthropicToken(credentials.refresh);
	},

	getApiKey(credentials: OAuthCredentials): string {
		return credentials.access;
	},
};
