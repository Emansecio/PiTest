import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildXaiAuthorizeUrl,
	getOAuthProvider,
	getOAuthProviders,
	pollXaiDeviceCodeToken,
	XAI_OAUTH_CLIENT_ID,
	xaiOAuthProvider,
} from "../src/utils/oauth/index.js";

describe("xAI Grok OAuth provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("is registered among built-in OAuth providers", () => {
		const ids = getOAuthProviders().map((p) => p.id);
		expect(ids).toContain("xai");
		expect(getOAuthProvider("xai")?.name).toMatch(/SuperGrok/i);
	});

	it("buildXaiAuthorizeUrl uses Grok-CLI client_id, pinned redirect, and plan=generic", () => {
		const url = buildXaiAuthorizeUrl({ challenge: "chal" }, "state1", "nonce1");
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe("https://auth.x.ai/oauth2/authorize");
		expect(parsed.searchParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
		expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:56121/callback");
		expect(parsed.searchParams.get("plan")).toBe("generic");
		expect(parsed.searchParams.get("code_challenge")).toBe("chal");
		expect(parsed.searchParams.get("scope")).toContain("grok-cli:access");
	});

	it("modifyModels injects grok-4.5 and Composer 2.5", () => {
		const models = xaiOAuthProvider.modifyModels?.([], {
			access: "a",
			refresh: "r",
			expires: Date.now() + 60_000,
		});
		const grok45 = models?.find((m) => m.id === "grok-4.5");
		const composer = models?.find((m) => m.id === "grok-composer-2.5-fast");
		expect(grok45?.provider).toBe("xai");
		expect(grok45?.baseUrl).toBe("https://api.x.ai/v1");
		expect(grok45?.contextWindow).toBe(500_000);
		expect(composer?.name).toBe("Composer 2.5");
		expect(composer?.baseUrl).toBe("https://cli-chat-proxy.grok.com/v1");
		expect(composer?.reasoning).toBe(true);
	});

	it("pollXaiDeviceCodeToken succeeds after authorization_pending", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: false,
				status: 400,
				json: async () => ({ error: "authorization_pending" }),
			})
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					access_token: "access-tok",
					refresh_token: "refresh-tok",
					expires_in: 3600,
				}),
			});
		vi.stubGlobal("fetch", fetchMock);

		const creds = await pollXaiDeviceCodeToken(
			{
				device_code: "dev",
				user_code: "ABCD",
				verification_uri: "https://auth.x.ai/device",
				expires_in: 120,
				interval: 1,
			},
			{ sleep: async () => {} },
		);

		expect(creds.access).toBe("access-tok");
		expect(creds.refresh).toBe("refresh-tok");
		expect(creds.expires).toBeGreaterThan(Date.now());
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
		expect(init?.signal).toBeDefined();
	});

	it("pollXaiDeviceCodeToken composes caller abort with fetch timeout", async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({
				access_token: "a",
				refresh_token: "r",
				expires_in: 60,
			}),
		});
		vi.stubGlobal("fetch", fetchMock);
		const ac = new AbortController();
		await pollXaiDeviceCodeToken(
			{
				device_code: "dev",
				user_code: "ABCD",
				verification_uri: "https://auth.x.ai/device",
				expires_in: 120,
				interval: 1,
			},
			{ sleep: async () => {}, signal: ac.signal },
		);
		const init = fetchMock.mock.calls[0]?.[1] as { signal?: AbortSignal };
		expect(init?.signal).toBeDefined();
		expect(init!.signal!.aborted).toBe(false);
		ac.abort();
		expect(init!.signal!.aborted).toBe(true);
	});

	it("login via device path when onSelect picks device", async () => {
		const fetchMock = vi
			.fn()
			// device code request
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					device_code: "dev",
					user_code: "WXYZ",
					verification_uri: "https://auth.x.ai/device",
					verification_uri_complete: "https://auth.x.ai/device?user_code=WXYZ",
					expires_in: 120,
					interval: 1,
				}),
			})
			// poll success
			.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					access_token: "a2",
					refresh_token: "r2",
					expires_in: 1800,
				}),
			});
		vi.stubGlobal("fetch", fetchMock);

		const onAuth = vi.fn();
		const creds = await xaiOAuthProvider.login({
			onAuth,
			onPrompt: async () => "",
			onSelect: async () => "device",
			onProgress: () => {},
		});

		expect(creds.access).toBe("a2");
		expect(onAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				url: "https://auth.x.ai/device?user_code=WXYZ",
			}),
		);
	});
});
