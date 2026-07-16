import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerOAuthProvider } from "@pit/ai/oauth";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.js";
import { clearConfigValueCache } from "../src/core/resolve-config-value.js";

describe("AuthStorage", () => {
	let tempDir: string;
	let authJsonPath: string;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-test-auth-storage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		authJsonPath = join(tempDir, "auth.json");
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
		clearConfigValueCache();
		vi.restoreAllMocks();
	});

	function writeAuthJson(data: Record<string, unknown>) {
		writeFileSync(authJsonPath, JSON.stringify(data));
	}

	describe("API key resolution", () => {
		test("literal API key is returned directly", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "sk-ant-literal-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("sk-ant-literal-key");
		});

		test("apiKey as environment variable name resolves to env value", async () => {
			const originalEnv = process.env.TEST_AUTH_API_KEY_12345;
			process.env.TEST_AUTH_API_KEY_12345 = "env-api-key-value";

			try {
				writeAuthJson({
					anthropic: { type: "api_key", key: "TEST_AUTH_API_KEY_12345" },
				});

				authStorage = AuthStorage.create(authJsonPath);
				const apiKey = await authStorage.getApiKey("anthropic");

				expect(apiKey).toBe("env-api-key-value");
			} finally {
				if (originalEnv === undefined) {
					delete process.env.TEST_AUTH_API_KEY_12345;
				} else {
					process.env.TEST_AUTH_API_KEY_12345 = originalEnv;
				}
			}
		});

		test("apiKey as literal value is used directly when not an env var", async () => {
			// Make sure this isn't an env var
			delete process.env.literal_api_key_value;

			writeAuthJson({
				anthropic: { type: "api_key", key: "literal_api_key_value" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("literal_api_key_value");
		});

		describe("caching", () => {
			test("environment variables are not cached (changes are picked up)", async () => {
				const envVarName = "TEST_AUTH_KEY_CACHE_TEST_98765";
				const originalEnv = process.env[envVarName];

				try {
					process.env[envVarName] = "first-value";

					writeAuthJson({
						anthropic: { type: "api_key", key: envVarName },
					});

					authStorage = AuthStorage.create(authJsonPath);

					const key1 = await authStorage.getApiKey("anthropic");
					expect(key1).toBe("first-value");

					// Change env var
					process.env[envVarName] = "second-value";

					const key2 = await authStorage.getApiKey("anthropic");
					expect(key2).toBe("second-value");
				} finally {
					if (originalEnv === undefined) {
						delete process.env[envVarName];
					} else {
						process.env[envVarName] = originalEnv;
					}
				}
			});
		});
	});

	describe("oauth lock compromise handling", () => {
		test("surfaces refresh failures instead of returning undefined", async () => {
			const providerId = `test-oauth-refresh-failure-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Refresh Failure",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken() {
					throw new Error("refresh rejected");
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			await expect(authStorage.getApiKey(providerId)).rejects.toThrow(
				`Failed to refresh OAuth token for ${providerId}: refresh rejected`,
			);
		});

		test("returns undefined on compromised lock and allows a later retry", async () => {
			const providerId = `test-oauth-provider-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Provider",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					return {
						...credentials,
						access: "refreshed-access-token",
						expires: Date.now() + 60_000,
					};
				},
				getApiKey(credentials) {
					return `Bearer ${credentials.access}`;
				},
			});

			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "expired-access-token",
					expires: Date.now() - 10_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const realLock = lockfile.lock.bind(lockfile);
			const lockSpy = vi.spyOn(lockfile, "lock");
			lockSpy.mockImplementationOnce(async (file, options) => {
				options?.onCompromised?.(new Error("Unable to update lock within the stale threshold"));
				return realLock(file, options);
			});

			const firstTry = await authStorage.getApiKey(providerId);
			expect(firstTry).toBeUndefined();

			lockSpy.mockRestore();

			const secondTry = await authStorage.getApiKey(providerId);
			expect(secondTry).toBe("Bearer refreshed-access-token");
		});
	});

	describe("oauth background pre-refresh (PIT_NO_OAUTH_PREFRESH)", () => {
		const originalFlag = process.env.PIT_NO_OAUTH_PREFRESH;

		beforeEach(() => {
			delete process.env.PIT_NO_OAUTH_PREFRESH;
		});

		afterEach(() => {
			if (originalFlag === undefined) delete process.env.PIT_NO_OAUTH_PREFRESH;
			else process.env.PIT_NO_OAUTH_PREFRESH = originalFlag;
		});

		function registerRefreshCountingProvider(options?: { refreshDelayMs?: number; fail?: boolean }) {
			const providerId = `test-oauth-prefresh-${Date.now()}-${Math.random().toString(36).slice(2)}`;
			const counters = { refreshCalls: 0 };
			registerOAuthProvider({
				id: providerId,
				name: "Test OAuth Prefresh",
				async login() {
					throw new Error("Not used in this test");
				},
				async refreshToken(credentials) {
					counters.refreshCalls++;
					if (options?.refreshDelayMs) {
						await new Promise((resolve) => setTimeout(resolve, options.refreshDelayMs));
					}
					if (options?.fail) {
						throw new Error("refresh rejected");
					}
					return {
						...credentials,
						access: "prefreshed-access-token",
						expires: Date.now() + 60 * 60_000,
					};
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			});
			return { providerId, counters };
		}

		function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
			return new Promise((resolve, reject) => {
				const started = Date.now();
				const tick = () => {
					if (predicate()) return resolve();
					if (Date.now() - started > timeoutMs) return reject(new Error("waitFor timed out"));
					setTimeout(tick, 10);
				};
				tick();
			});
		}

		test("near-expiry token is returned immediately and refreshed in the background", async () => {
			const { providerId, counters } = registerRefreshCountingProvider();
			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "still-valid-access-token",
					expires: Date.now() + 5 * 60_000, // valid, but inside the ~10min pre-refresh window
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Hot path: hands out the CURRENT (still valid) token without waiting.
			expect(await authStorage.getApiKey(providerId)).toBe("still-valid-access-token");

			// The fire-and-forget refresh lands out-of-band and persists new creds.
			await waitFor(() => counters.refreshCalls === 1);
			await waitFor(() => {
				const stored = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { access?: string }>;
				return stored[providerId]?.access === "prefreshed-access-token";
			});

			// Next call serves the refreshed token, again without a sync refresh.
			expect(await authStorage.getApiKey(providerId)).toBe("prefreshed-access-token");
			expect(counters.refreshCalls).toBe(1);
		});

		test("pre-refresh is single-flight: concurrent getApiKey calls do not stack refreshes", async () => {
			const { providerId, counters } = registerRefreshCountingProvider({ refreshDelayMs: 150 });
			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "still-valid-access-token",
					expires: Date.now() + 5 * 60_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			const keys = await Promise.all([
				authStorage.getApiKey(providerId),
				authStorage.getApiKey(providerId),
				authStorage.getApiKey(providerId),
			]);
			expect(keys).toEqual(["still-valid-access-token", "still-valid-access-token", "still-valid-access-token"]);

			await waitFor(() => counters.refreshCalls >= 1);
			// Give any (wrong) stacked refresh a chance to fire before asserting.
			await new Promise((resolve) => setTimeout(resolve, 250));
			expect(counters.refreshCalls).toBe(1);
		});

		test("token far from expiry does not trigger a background refresh", async () => {
			const { providerId, counters } = registerRefreshCountingProvider();
			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "long-lived-access-token",
					expires: Date.now() + 60 * 60_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			expect(await authStorage.getApiKey(providerId)).toBe("long-lived-access-token");
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(counters.refreshCalls).toBe(0);
		});

		test("PIT_NO_OAUTH_PREFRESH=1 disables the background refresh", async () => {
			process.env.PIT_NO_OAUTH_PREFRESH = "1";
			const { providerId, counters } = registerRefreshCountingProvider();
			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "still-valid-access-token",
					expires: Date.now() + 5 * 60_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			expect(await authStorage.getApiKey(providerId)).toBe("still-valid-access-token");
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect(counters.refreshCalls).toBe(0);
		});

		test("a failing background refresh stays invisible; sync fallback still works", async () => {
			const { providerId, counters } = registerRefreshCountingProvider({ fail: true });
			writeAuthJson({
				[providerId]: {
					type: "oauth",
					refresh: "refresh-token",
					access: "still-valid-access-token",
					expires: Date.now() + 5 * 60_000,
				},
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Hot path unaffected by the (background) failure.
			expect(await authStorage.getApiKey(providerId)).toBe("still-valid-access-token");
			await waitFor(() => counters.refreshCalls === 1);

			// Token remains the original one; a later call still serves it while valid.
			expect(await authStorage.getApiKey(providerId)).toBe("still-valid-access-token");
		});
	});

	describe("persistence semantics", () => {
		test("set preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "old-anthropic" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.set("anthropic", { type: "api_key", key: "new-anthropic" });

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic.key).toBe("new-anthropic");
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("remove preserves unrelated external edits", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);

			// Simulate external edit while process is running
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
				openai: { type: "api_key", key: "openai-key" },
				google: { type: "api_key", key: "google-key" },
			});

			authStorage.remove("anthropic");

			const updated = JSON.parse(readFileSync(authJsonPath, "utf-8")) as Record<string, { key: string }>;
			expect(updated.anthropic).toBeUndefined();
			expect(updated.openai.key).toBe("openai-key");
			expect(updated.google.key).toBe("google-key");
		});

		test("does not overwrite malformed auth file after load error", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();
			authStorage.set("openai", { type: "api_key", key: "openai-key" });

			const raw = readFileSync(authJsonPath, "utf-8");
			expect(raw).toBe("{invalid-json");
		});

		test("reload records parse errors and drainErrors clears buffer", () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "anthropic-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			writeFileSync(authJsonPath, "{invalid-json", "utf-8");

			authStorage.reload();

			// Keeps previous in-memory data on reload failure
			expect(authStorage.get("anthropic")).toEqual({ type: "api_key", key: "anthropic-key" });

			const firstDrain = authStorage.drainErrors();
			expect(firstDrain.length).toBeGreaterThan(0);
			expect(firstDrain[0]).toBeInstanceOf(Error);

			const secondDrain = authStorage.drainErrors();
			expect(secondDrain).toHaveLength(0);
		});
	});

	describe("auth status", () => {
		test("does not expose stored API keys or OAuth tokens", () => {
			authStorage = AuthStorage.inMemory({
				anthropic: { type: "api_key", key: "secret-api-key" },
				openai: {
					type: "oauth",
					access: "secret-access-token",
					refresh: "secret-refresh-token",
					expires: Date.now() + 1000,
				},
			});

			expect(authStorage.getAuthStatus("anthropic")).toEqual({ configured: true, source: "stored" });
			expect(authStorage.getAuthStatus("openai")).toEqual({ configured: true, source: "stored" });
			expect(JSON.stringify(authStorage.getAuthStatus("anthropic"))).not.toContain("secret-api-key");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-access-token");
			expect(JSON.stringify(authStorage.getAuthStatus("openai"))).not.toContain("secret-refresh-token");
		});
	});

	describe("runtime overrides", () => {
		test("runtime override takes priority over auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("runtime-key");
		});

		test("removing runtime override falls back to auth.json", async () => {
			writeAuthJson({
				anthropic: { type: "api_key", key: "stored-key" },
			});

			authStorage = AuthStorage.create(authJsonPath);
			authStorage.setRuntimeApiKey("anthropic", "runtime-key");
			authStorage.removeRuntimeApiKey("anthropic");

			const apiKey = await authStorage.getApiKey("anthropic");

			expect(apiKey).toBe("stored-key");
		});
	});

	describe("credential alias groups (opencode ↔ opencode-go)", () => {
		let savedEnv: string | undefined;
		beforeEach(() => {
			savedEnv = process.env.OPENCODE_API_KEY;
			delete process.env.OPENCODE_API_KEY;
		});
		afterEach(() => {
			if (savedEnv === undefined) delete process.env.OPENCODE_API_KEY;
			else process.env.OPENCODE_API_KEY = savedEnv;
		});

		test("login stored under opencode-go authenticates opencode (zen)", async () => {
			authStorage = AuthStorage.inMemory({
				"opencode-go": { type: "api_key", key: "oc-shared-key" },
			});

			expect(authStorage.hasAuth("opencode")).toBe(true);
			expect(await authStorage.getApiKey("opencode")).toBe("oc-shared-key");
			// Actual requests resolve auth with includeFallback:false — must still share.
			expect(await authStorage.getApiKey("opencode", { includeFallback: false })).toBe("oc-shared-key");
			expect(authStorage.getAuthStatus("opencode")).toEqual({
				configured: true,
				source: "stored",
				label: "via opencode-go",
			});
		});

		test("login stored under opencode authenticates opencode-go", async () => {
			authStorage = AuthStorage.inMemory({
				opencode: { type: "api_key", key: "oc-zen-key" },
			});

			expect(authStorage.hasAuth("opencode-go")).toBe(true);
			expect(await authStorage.getApiKey("opencode-go")).toBe("oc-zen-key");
		});

		test("a provider's own credential wins over the sibling", async () => {
			authStorage = AuthStorage.inMemory({
				opencode: { type: "api_key", key: "oc-zen-key" },
				"opencode-go": { type: "api_key", key: "oc-go-key" },
			});

			expect(await authStorage.getApiKey("opencode")).toBe("oc-zen-key");
			expect(await authStorage.getApiKey("opencode-go")).toBe("oc-go-key");
		});

		test("unrelated provider is not authenticated by an opencode credential", () => {
			authStorage = AuthStorage.inMemory({
				"opencode-go": { type: "api_key", key: "oc-shared-key" },
			});

			expect(authStorage.hasAuth("anthropic")).toBe(false);
		});
	});
});
