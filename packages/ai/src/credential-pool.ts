/**
 * First-ready API credential pool with session affinity and failover rotation.
 *
 * Each provider owns a list of credential entries. Entries may be cooled
 * down after rate-limit / auth failures so callers transparently rotate to
 * the next available key.
 *
 * Session affinity: callers that pass a stable `sessionId` get sticky
 * assignment so prompt-cache continuity is preserved within a session.
 */

export type CredentialSource = "env" | "settings" | "oauth" | "runtime";

export interface CredentialEntry {
	key: string;
	source: CredentialSource;
	/** Epoch ms when cooldown ends. Absent means ready. */
	cooldownUntil?: number;
	/** Recent consecutive failures (cleared on success). */
	failures?: number;
}

export type CredentialFailureReason = "rate-limit" | "auth" | "other";

export interface CredentialPool {
	register(provider: string, entries: CredentialEntry[]): void;
	addRuntimeKey(provider: string, key: string): void;
	count(provider: string): number;
	pick(provider: string, sessionId?: string): { entry: CredentialEntry; index: number } | undefined;
	markFailure(provider: string, key: string, reason: CredentialFailureReason): void;
	markSuccess(provider: string, key: string): void;
	awaitFreeSlot(provider: string, timeoutMs: number): Promise<void>;
}

interface ProviderState {
	entries: CredentialEntry[];
	sticky: Map<string, string>; // sessionId -> key
}

const DEFAULT_COOLDOWN_MS = 300_000;

function readEnvCooldownMs(): number {
	const raw = typeof process !== "undefined" ? process.env?.PIT_KEY_COOLDOWN_MS : undefined;
	if (!raw) return DEFAULT_COOLDOWN_MS;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_COOLDOWN_MS;
}

class CredentialPoolImpl implements CredentialPool {
	private providers = new Map<string, ProviderState>();

	private ensure(provider: string): ProviderState {
		let state = this.providers.get(provider);
		if (!state) {
			state = { entries: [], sticky: new Map() };
			this.providers.set(provider, state);
		}
		return state;
	}

	register(provider: string, entries: CredentialEntry[]): void {
		const state = this.ensure(provider);
		// Replace entries but preserve cooldown / failure state for keys we already know.
		const previous = new Map(state.entries.map((e) => [e.key, e]));
		state.entries = entries.map((e) => {
			const prior = previous.get(e.key);
			if (prior) {
				return {
					...e,
					cooldownUntil: e.cooldownUntil ?? prior.cooldownUntil,
					failures: e.failures ?? prior.failures,
				};
			}
			return { ...e };
		});
		// Drop sticky assignments that reference removed keys.
		const keep = new Set(state.entries.map((e) => e.key));
		for (const [session, key] of state.sticky) {
			if (!keep.has(key)) state.sticky.delete(session);
		}
	}

	addRuntimeKey(provider: string, key: string): void {
		const state = this.ensure(provider);
		if (state.entries.some((e) => e.key === key)) return;
		state.entries.push({ key, source: "runtime" });
	}

	count(provider: string): number {
		return this.providers.get(provider)?.entries.length ?? 0;
	}

	private isReady(entry: CredentialEntry, now: number): boolean {
		return entry.cooldownUntil === undefined || entry.cooldownUntil <= now;
	}

	pick(provider: string, sessionId?: string): { entry: CredentialEntry; index: number } | undefined {
		const state = this.providers.get(provider);
		if (!state || state.entries.length === 0) return undefined;
		const now = Date.now();

		if (sessionId) {
			const stickyKey = state.sticky.get(sessionId);
			if (stickyKey) {
				const idx = state.entries.findIndex((e) => e.key === stickyKey);
				if (idx >= 0 && this.isReady(state.entries[idx]!, now)) {
					return { entry: state.entries[idx]!, index: idx };
				}
				// Sticky is cooled or gone — re-assign below.
				state.sticky.delete(sessionId);
			}
		}

		for (let i = 0; i < state.entries.length; i++) {
			const entry = state.entries[i]!;
			if (this.isReady(entry, now)) {
				if (sessionId) state.sticky.set(sessionId, entry.key);
				return { entry, index: i };
			}
		}
		return undefined;
	}

	markFailure(provider: string, key: string, reason: CredentialFailureReason): void {
		const state = this.providers.get(provider);
		if (!state) return;
		const entry = state.entries.find((e) => e.key === key);
		if (!entry) return;
		entry.failures = (entry.failures ?? 0) + 1;
		if (reason === "rate-limit") {
			entry.cooldownUntil = Date.now() + readEnvCooldownMs();
		} else if (reason === "auth") {
			// Permanently sideline an invalid key for this process.
			entry.cooldownUntil = Number.POSITIVE_INFINITY;
		}
		// `other`: do not cooldown — caller likely retries elsewhere.
	}

	markSuccess(provider: string, key: string): void {
		const state = this.providers.get(provider);
		if (!state) return;
		const entry = state.entries.find((e) => e.key === key);
		if (!entry) return;
		entry.failures = 0;
		// Don't clear cooldown — it expires on its own. Successful call implies
		// the entry wasn't cooled when picked, so this is just a hygiene reset.
	}

	awaitFreeSlot(provider: string, timeoutMs: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const state = this.providers.get(provider);
			if (!state || state.entries.length === 0) {
				resolve();
				return;
			}
			const now = Date.now();
			if (state.entries.some((e) => this.isReady(e, now))) {
				resolve();
				return;
			}
			let soonest = Number.POSITIVE_INFINITY;
			for (const e of state.entries) {
				if (e.cooldownUntil !== undefined && e.cooldownUntil < soonest) {
					soonest = e.cooldownUntil;
				}
			}
			const waitMs = Math.min(timeoutMs, Math.max(0, soonest - now));
			if (!Number.isFinite(waitMs) || waitMs >= timeoutMs) {
				// All keys cooled longer than timeout — fail fast.
				reject(new Error(`No credentials ready for ${provider} within ${timeoutMs}ms`));
				return;
			}
			setTimeout(() => resolve(), waitMs);
		});
	}
}

let _pool: CredentialPool | undefined;

export function getCredentialPool(): CredentialPool {
	if (!_pool) _pool = new CredentialPoolImpl();
	return _pool;
}

/** Test helper — reset module state. Not exported from index. */
export function _resetCredentialPool(): void {
	_pool = undefined;
}
