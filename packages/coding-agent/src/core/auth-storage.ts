/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple pi instances
 * try to refresh tokens simultaneously.
 */

import {
	findEnvKeys,
	getEnvApiKey,
	getEnvApiKeys,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type OAuthProviderId,
} from "@pit/ai";
import { getOAuthApiKey, getOAuthProvider, getOAuthProviders } from "@pit/ai/oauth";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { resolveConfigValue, resolveConfigValueUncachedAsync } from "./resolve-config-value.ts";

/**
 * Background pre-refresh window: when `getApiKey` hands out a still-valid OAuth
 * token that expires within this window, a fire-and-forget refresh is kicked
 * off so the (30s-timeout) refresh POST + file lock happen OUTSIDE the request
 * hot path. Sized comfortably above the 60s proactive buffer in
 * `@pit/ai` `getOAuthApiKey` and Anthropic's 5-minute margin already baked into
 * `expires`, so the synchronous refresh path almost never triggers.
 * Kill-switch: PIT_NO_OAUTH_PREFRESH=1.
 */
const OAUTH_PREFRESH_WINDOW_MS = 10 * 60_000;

// Shared buffer backing Atomics.wait() for lock-retry sleeps. Yields the thread
// instead of busy-spinning (mirrors SettingsManager's lock-retry strategy).
const AUTH_LOCK_SLEEP_BUF = new Int32Array(new SharedArrayBuffer(4));

export type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

export type OAuthCredential = {
	type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

export type AuthStatus = {
	configured: boolean;
	source?: "stored" | "runtime" | "environment" | "fallback" | "models_json_key" | "models_json_command";
	label?: string;
};

type LockResult<T> = {
	result: T;
	next?: string;
};

export interface AuthStorageBackend {
	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
	withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
	private authPath: string;

	constructor(authPath: string = join(getAgentDir(), "auth.json")) {
		this.authPath = authPath;
	}

	private ensureParentDir(): void {
		const dir = dirname(this.authPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true, mode: 0o700 });
		}
	}

	private ensureFileExists(): void {
		if (!existsSync(this.authPath)) {
			writeFileSync(this.authPath, "{}", "utf-8");
			chmodSync(this.authPath, 0o600);
		}
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				// Sleep synchronously without burning CPU; Atomics.wait yields the thread.
				Atomics.wait(AUTH_LOCK_SLEEP_BUF, 0, 0, delayMs);
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire auth storage lock");
	}

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => void) | undefined;
		try {
			release = this.acquireLockSyncWithRetry(this.authPath);
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = fn(current);
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			return result;
		} finally {
			if (release) {
				release();
			}
		}
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		this.ensureParentDir();
		this.ensureFileExists();

		let release: (() => Promise<void>) | undefined;
		let lockCompromised = false;
		let lockCompromisedError: Error | undefined;
		const throwIfCompromised = () => {
			if (lockCompromised) {
				throw lockCompromisedError ?? new Error("Auth storage lock was compromised");
			}
		};

		try {
			release = await lockfile.lock(this.authPath, {
				retries: {
					retries: 10,
					factor: 2,
					minTimeout: 100,
					maxTimeout: 10000,
					randomize: true,
				},
				stale: 30000,
				onCompromised: (err) => {
					lockCompromised = true;
					lockCompromisedError = err;
				},
			});

			throwIfCompromised();
			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
			const { result, next } = await fn(current);
			throwIfCompromised();
			if (next !== undefined) {
				writeFileSync(this.authPath, next, "utf-8");
				chmodSync(this.authPath, 0o600);
			}
			throwIfCompromised();
			return result;
		} finally {
			if (release) {
				try {
					await release();
				} catch {
					// Ignore unlock errors when lock is compromised.
				}
			}
		}
	}
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
	private value: string | undefined;

	withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
		const { result, next } = fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}

	async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
		const { result, next } = await fn(this.value);
		if (next !== undefined) {
			this.value = next;
		}
		return result;
	}
}

/**
 * Providers that share a single upstream account / API key, so a credential
 * stored (or overridden) under one id authenticates the others. OpenCode Zen
 * and OpenCode Go are the same opencode.ai account on different endpoints — the
 * per-model `baseUrl` differs but the bearer key is identical (env-api-keys maps
 * both to OPENCODE_API_KEY). Without this, a `/login` to one leaves the other's
 * models hidden from the picker even though the same key would work.
 */
const CREDENTIAL_ALIAS_GROUPS: ReadonlyArray<ReadonlySet<string>> = [new Set(["opencode", "opencode-go"])];

/** Sibling provider ids that share credentials with `providerId` (excluding itself). */
function getCredentialAliases(providerId: string): string[] {
	for (const group of CREDENTIAL_ALIAS_GROUPS) {
		if (group.has(providerId)) return [...group].filter((id) => id !== providerId);
	}
	return [];
}

/**
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
	private data: AuthStorageData = {};
	private runtimeOverrides: Map<string, string> = new Map();
	private fallbackResolver?: (provider: string) => string | undefined;
	private loadError: Error | null = null;
	private errors: Error[] = [];
	private storage: AuthStorageBackend;

	private constructor(storage: AuthStorageBackend) {
		this.storage = storage;
		this.reload();
	}

	static create(authPath?: string): AuthStorage {
		return new AuthStorage(new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")));
	}

	static fromStorage(storage: AuthStorageBackend): AuthStorage {
		return new AuthStorage(storage);
	}

	static inMemory(data: AuthStorageData = {}): AuthStorage {
		const storage = new InMemoryAuthStorageBackend();
		storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
		return AuthStorage.fromStorage(storage);
	}

	/**
	 * Set a runtime API key override (not persisted to disk).
	 * Used for CLI --api-key flag.
	 */
	setRuntimeApiKey(provider: string, apiKey: string): void {
		this.runtimeOverrides.set(provider, apiKey);
	}

	/**
	 * Remove a runtime API key override.
	 */
	removeRuntimeApiKey(provider: string): void {
		this.runtimeOverrides.delete(provider);
	}

	/**
	 * Set a fallback resolver for API keys not found in auth.json or env vars.
	 * Used for custom provider keys from models.json.
	 */
	setFallbackResolver(resolver: (provider: string) => string | undefined): void {
		this.fallbackResolver = resolver;
	}

	private recordError(error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push(normalizedError);
	}

	private parseStorageData(content: string | undefined): AuthStorageData {
		if (!content) {
			return {};
		}
		return JSON.parse(content) as AuthStorageData;
	}

	/**
	 * Reload credentials from storage.
	 */
	reload(): void {
		let content: string | undefined;
		try {
			this.storage.withLock((current) => {
				content = current;
				return { result: undefined };
			});
			this.data = this.parseStorageData(content);
			this.loadError = null;
		} catch (error) {
			this.loadError = error as Error;
			this.recordError(error);
		}
	}

	private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
		if (this.loadError) {
			return;
		}

		try {
			this.storage.withLock((current) => {
				const currentData = this.parseStorageData(current);
				const merged: AuthStorageData = { ...currentData };
				if (credential) {
					merged[provider] = credential;
				} else {
					delete merged[provider];
				}
				return { result: undefined, next: JSON.stringify(merged, null, 2) };
			});
		} catch (error) {
			this.recordError(error);
		}
	}

	/**
	 * Get credential for a provider.
	 */
	get(provider: string): AuthCredential | undefined {
		return this.data[provider] ?? undefined;
	}

	/**
	 * Set credential for a provider.
	 */
	set(provider: string, credential: AuthCredential): void {
		this.data[provider] = credential;
		this.persistProviderChange(provider, credential);
	}

	/**
	 * Remove credential for a provider.
	 */
	remove(provider: string): void {
		delete this.data[provider];
		this.persistProviderChange(provider, undefined);
	}

	/**
	 * List all providers with credentials.
	 */
	list(): string[] {
		return Object.keys(this.data);
	}

	/**
	 * Check if credentials exist for a provider in auth.json.
	 */
	has(provider: string): boolean {
		return provider in this.data;
	}

	/**
	 * Check if any form of auth is configured for a provider.
	 * Unlike getApiKey(), this doesn't refresh OAuth tokens.
	 */
	hasAuth(provider: string): boolean {
		if (this.runtimeOverrides.has(provider)) return true;
		if (this.data[provider]) return true;
		if (getEnvApiKey(provider)) return true;
		if (this.fallbackResolver?.(provider)) return true;
		// Shared-account siblings (e.g. opencode ↔ opencode-go) authenticate each other.
		for (const alias of getCredentialAliases(provider)) {
			if (this.runtimeOverrides.has(alias)) return true;
			if (this.data[alias]?.type === "api_key") return true;
		}
		return false;
	}

	/**
	 * Return auth status without exposing credential values or refreshing tokens.
	 */
	getAuthStatus(provider: string): AuthStatus {
		if (this.data[provider]) {
			return { configured: true, source: "stored" };
		}

		if (this.runtimeOverrides.has(provider)) {
			return { configured: false, source: "runtime", label: "--api-key" };
		}

		const envKeys = findEnvKeys(provider);
		if (envKeys?.[0]) {
			return { configured: false, source: "environment", label: envKeys[0] };
		}

		if (this.fallbackResolver?.(provider)) {
			return { configured: false, source: "fallback", label: "custom provider config" };
		}

		// Authenticated via a shared-account sibling (e.g. opencode ↔ opencode-go).
		for (const alias of getCredentialAliases(provider)) {
			if (this.runtimeOverrides.has(alias)) return { configured: false, source: "runtime", label: "--api-key" };
			if (this.data[alias]?.type === "api_key") return { configured: true, source: "stored", label: `via ${alias}` };
		}

		return { configured: false };
	}

	/**
	 * Get all credentials (for passing to getOAuthApiKey).
	 */
	getAll(): AuthStorageData {
		return { ...this.data };
	}

	drainErrors(): Error[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	/**
	 * Login to an OAuth provider.
	 */
	async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			throw new Error(`Unknown OAuth provider: ${providerId}`);
		}

		const credentials = await provider.login(callbacks);
		this.set(providerId, { type: "oauth", ...credentials });
	}

	/**
	 * Logout from a provider.
	 */
	logout(provider: string): void {
		this.remove(provider);
	}

	/**
	 * Refresh OAuth token with backend locking to prevent race conditions.
	 * Multiple pi instances may try to refresh simultaneously when tokens expire.
	 *
	 * `minValidityMs` widens the "needs refresh" test: a token that is still
	 * valid but expires within that window is force-refreshed. The background
	 * pre-refresh passes `OAUTH_PREFRESH_WINDOW_MS`; the synchronous hot-path
	 * fallback keeps the default 0 (refresh only when actually expired). The
	 * post-lock re-read makes this single-flight across instances too: if
	 * another process already refreshed, the fresh `expires` short-circuits
	 * without a network call.
	 */
	private async refreshOAuthTokenWithLock(
		providerId: OAuthProviderId,
		minValidityMs = 0,
	): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
		const provider = getOAuthProvider(providerId);
		if (!provider) {
			return null;
		}

		const result = await this.storage.withLockAsync(async (current) => {
			const currentData = this.parseStorageData(current);
			this.data = currentData;
			this.loadError = null;

			const cred = currentData[providerId];
			if (cred?.type !== "oauth") {
				return { result: null };
			}

			if (Date.now() < cred.expires - minValidityMs) {
				return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
			}

			// Pre-refresh path: the token is still valid but inside the near-expiry
			// window. `getOAuthApiKey` would decline to refresh a token this far from
			// `expires` (its buffer is 60s), so force the refresh directly. Error
			// message mirrors getOAuthApiKey's so downstream auth-failure matching
			// (isOAuthReauthRequired, E2E autoskip) treats both paths identically.
			if (Date.now() < cred.expires) {
				let newCredentials: OAuthCredentials;
				try {
					newCredentials = await provider.refreshToken(cred);
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					throw new Error(`Failed to refresh OAuth token for ${providerId}: ${detail}`);
				}
				const merged: AuthStorageData = {
					...currentData,
					[providerId]: { type: "oauth", ...newCredentials },
				};
				this.data = merged;
				this.loadError = null;
				return {
					result: { apiKey: provider.getApiKey(newCredentials), newCredentials },
					next: JSON.stringify(merged, null, 2),
				};
			}

			const oauthCreds: Record<string, OAuthCredentials> = {};
			for (const [key, value] of Object.entries(currentData)) {
				if (value.type === "oauth") {
					oauthCreds[key] = value;
				}
			}

			const refreshed = await getOAuthApiKey(providerId, oauthCreds);
			if (!refreshed) {
				return { result: null };
			}

			const merged: AuthStorageData = {
				...currentData,
				[providerId]: { type: "oauth", ...refreshed.newCredentials },
			};
			this.data = merged;
			this.loadError = null;
			return { result: refreshed, next: JSON.stringify(merged, null, 2) };
		});

		return result;
	}

	/** Providers with a background pre-refresh currently in flight (single-flight guard). */
	private prefreshInFlight = new Set<string>();

	/**
	 * Fire-and-forget near-expiry OAuth refresh (§2.3): kicked off by `getApiKey`
	 * when the returned token is still valid but expires within
	 * `OAUTH_PREFRESH_WINDOW_MS`, so the refresh POST (30s timeout worst case)
	 * happens outside the request hot path. Errors are swallowed — the
	 * synchronous refresh in `getApiKey` remains the correct fallback if the
	 * token actually expires before a background attempt succeeds. The in-flight
	 * set prevents stacking within this instance; the file lock (plus the
	 * post-lock `expires` re-check) covers races across instances.
	 */
	private maybePrefreshOAuthToken(providerId: string, cred: OAuthCredential): void {
		if (isTruthyEnvFlag(process.env.PIT_NO_OAUTH_PREFRESH)) {
			return;
		}
		const remainingMs = cred.expires - Date.now();
		if (remainingMs <= 0 || remainingMs >= OAUTH_PREFRESH_WINDOW_MS) {
			return;
		}
		if (this.prefreshInFlight.has(providerId)) {
			return;
		}
		this.prefreshInFlight.add(providerId);
		void this.refreshOAuthTokenWithLock(providerId as OAuthProviderId, OAUTH_PREFRESH_WINDOW_MS)
			.catch(() => {
				// Best-effort: a failed background refresh must stay invisible —
				// the sync path will refresh (and surface real errors) on demand.
			})
			.finally(() => {
				this.prefreshInFlight.delete(providerId);
			});
	}

	/**
	 * Get API key for a provider.
	 * Priority:
	 * 1. Runtime override (CLI --api-key)
	 * 2. API key from auth.json
	 * 3. OAuth token from auth.json (auto-refreshed with locking)
	 * 4. Environment variable
	 * 5. Fallback resolver (models.json custom providers)
	 */
	async getApiKey(providerId: string, options?: { includeFallback?: boolean }): Promise<string | undefined> {
		// Runtime override takes highest priority
		const runtimeKey = this.runtimeOverrides.get(providerId);
		if (runtimeKey) {
			return runtimeKey;
		}

		const cred = this.data[providerId];

		if (cred?.type === "api_key") {
			return await resolveConfigValueUncachedAsync(cred.key);
		}

		if (cred?.type === "oauth") {
			const provider = getOAuthProvider(providerId);
			if (!provider) {
				// Unknown OAuth provider, can't get API key
				return undefined;
			}

			// Check if token needs refresh
			const needsRefresh = Date.now() >= cred.expires;

			if (needsRefresh) {
				// Use locked refresh to prevent race conditions
				try {
					const result = await this.refreshOAuthTokenWithLock(providerId);
					if (result) {
						return result.apiKey;
					}
				} catch (error) {
					this.recordError(error);
					// Refresh failed - re-read file to check if another instance succeeded
					this.reload();
					const updatedCred = this.data[providerId];

					if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
						// Another instance refreshed successfully, use those credentials
						return provider.getApiKey(updatedCred);
					}

					// Refresh truly failed. Surface the auth failure to the active request
					// instead of degrading to a misleading "missing API key" error.
					if (
						error instanceof Error &&
						error.message.includes("Unable to update lock within the stale threshold")
					) {
						return undefined;
					}
					throw error;
				}
			} else {
				// Token not expired: hand it out immediately, but if it is inside the
				// near-expiry window, kick off a background refresh so the NEXT call
				// never pays the synchronous refresh on the hot path.
				this.maybePrefreshOAuthToken(providerId, cred);
				return provider.getApiKey(cred);
			}
		}

		// Fall back to environment variable
		const envKey = getEnvApiKey(providerId);
		if (envKey) return envKey;

		// Shared-account siblings (opencode ↔ opencode-go use the same key): reuse a
		// sibling's runtime/stored API key so a single /login covers both endpoints.
		// Runs before the includeFallback guard so actual requests (which pass
		// includeFallback:false) still resolve the shared key.
		for (const alias of getCredentialAliases(providerId)) {
			const runtimeAlias = this.runtimeOverrides.get(alias);
			if (runtimeAlias) return runtimeAlias;
			const aliasCred = this.data[alias];
			if (aliasCred?.type === "api_key") return await resolveConfigValueUncachedAsync(aliasCred.key);
		}

		// Fall back to custom resolver (e.g., models.json custom providers)
		if (options?.includeFallback !== false) {
			return this.fallbackResolver?.(providerId) ?? undefined;
		}

		return undefined;
	}

	/**
	 * Get all registered OAuth providers
	 */
	getOAuthProviders() {
		return getOAuthProviders();
	}

	/**
	 * Collect every static API key configured for a provider, in priority
	 * order (runtime override → stored api_key → env primary + round-robin
	 * extensions → fallback resolver). Does NOT include OAuth tokens since
	 * those need async refresh; OAuth flows continue to use `getApiKey`.
	 *
	 * Used to seed the credential pool with round-robin keys.
	 */
	getAllApiKeysForProvider(providerId: string): string[] {
		const out: string[] = [];
		const seen = new Set<string>();
		const push = (k: string | undefined) => {
			if (!k) return;
			if (seen.has(k)) return;
			seen.add(k);
			out.push(k);
		};

		const runtimeKey = this.runtimeOverrides.get(providerId);
		push(runtimeKey);

		const cred = this.data[providerId];
		if (cred?.type === "api_key") {
			push(resolveConfigValue(cred.key));
		}

		for (const k of getEnvApiKeys(providerId)) push(k);

		const fb = this.fallbackResolver?.(providerId);
		push(fb);

		return out;
	}
}
