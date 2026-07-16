/**
 * Fallback-chain retry orchestrator.
 *
 * Wraps a single stream/turn call with an ordered list of model entries. When
 * the primary throws a retryable error (rate-limit / quota / refused /
 * idle-socket reset / 5xx), the next entry takes over for the rest of the turn. A module-level cooldown
 * map prevents hammering a model that just failed.
 */

import type { Api, Model, ThinkingLevel } from "./types.ts";

export interface FallbackChainEntry {
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
}

export interface RetryConfig {
	/** Ordered chain. entry[0] is the primary. */
	chain: FallbackChainEntry[];
	/** Cooldown applied to a failing entry before it is eligible again. Default: 5 min. */
	cooldownMs?: number;
	/** Predicate to decide whether to fall over. Defaults to network/quota classifier. */
	isRetryable?: (err: unknown) => boolean;
}

const DEFAULT_COOLDOWN_MS = 300_000;
const MAX_WAIT_FOR_COOLDOWN_MS = 30_000;

// ECONNRESET/EPIPE/"socket hang up"/"other side closed" are what a keep-alive
// socket killed by server idle timeout surfaces as on the next POST (undici
// does not replay POSTs automatically) — retryable against the next entry.
const RETRYABLE_MESSAGE_REGEX =
	/429|529|overloaded|rate.?limit|quota|connection.?refused|ECONNREFUSED|ECONNRESET|EPIPE|ETIMEDOUT|socket hang up|other side closed|insufficient.{0,20}quota/i;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);
const NON_RETRYABLE_STATUSES = new Set([401, 403, 404]);

const cooldownMap = new Map<string, { until: number }>();

function entryKey(entry: FallbackChainEntry): string {
	return `${entry.model.provider}/${entry.model.id}`;
}

function inCooldown(entry: FallbackChainEntry, now: number): boolean {
	const cd = cooldownMap.get(entryKey(entry));
	return cd !== undefined && cd.until > now;
}

function setCooldown(entry: FallbackChainEntry, cooldownMs: number): void {
	cooldownMap.set(entryKey(entry), { until: Date.now() + cooldownMs });
}

export function defaultIsRetryable(err: unknown): boolean {
	if (err === null || err === undefined) return false;
	const anyErr = err as { status?: unknown; statusCode?: unknown; message?: unknown };
	const status =
		typeof anyErr.status === "number"
			? anyErr.status
			: typeof anyErr.statusCode === "number"
				? anyErr.statusCode
				: undefined;
	if (status !== undefined) {
		if (NON_RETRYABLE_STATUSES.has(status)) return false;
		if (RETRYABLE_STATUSES.has(status)) return true;
	}
	const message = typeof anyErr.message === "string" ? anyErr.message : String(err);
	return RETRYABLE_MESSAGE_REGEX.test(message);
}

/** Clear all tracked cooldowns. Test helper. */
export function _resetFallbackCooldowns(): void {
	cooldownMap.clear();
}

/**
 * Cross-turn cooldown probe used by external callers (e.g. AgentSession's
 * fallback-chain picker) to skip entries that already ate a retryable failure
 * in a prior turn. Reads the same module-level map that `withFallbackChain`
 * mutates internally.
 */
export function isEntryCooledDown(provider: string, modelId: string): boolean {
	const cd = cooldownMap.get(`${provider}/${modelId}`);
	return cd !== undefined && cd.until > Date.now();
}

/**
 * Record a cooldown for an entry from outside the chain executor. Used by
 * AgentSession when a turn-level failure should suppress the same entry on
 * subsequent turns until the cooldown expires.
 */
export function markEntryCooldown(provider: string, modelId: string, ms: number): void {
	cooldownMap.set(`${provider}/${modelId}`, { until: Date.now() + Math.max(0, ms) });
}

/**
 * Run `call` against the primary entry. On retryable failure, walk the chain.
 * If every remaining entry is in cooldown, wait up to 30s for the soonest
 * expiry; if still locked, rethrow the last seen error.
 */
export async function withFallbackChain<T>(
	config: RetryConfig,
	call: (entry: FallbackChainEntry) => Promise<T>,
): Promise<T> {
	const { chain } = config;
	if (chain.length === 0) {
		throw new Error("withFallbackChain: chain is empty");
	}
	const cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	const isRetryable = config.isRetryable ?? defaultIsRetryable;

	let lastError: unknown;
	const tried = new Set<string>();

	while (tried.size < chain.length) {
		const now = Date.now();
		let entry: FallbackChainEntry | undefined;
		for (const candidate of chain) {
			const key = entryKey(candidate);
			if (tried.has(key)) continue;
			if (inCooldown(candidate, now)) continue;
			entry = candidate;
			break;
		}

		if (!entry) {
			// All remaining entries are in cooldown — wait for the soonest expiry.
			let soonest = Number.POSITIVE_INFINITY;
			for (const candidate of chain) {
				const key = entryKey(candidate);
				if (tried.has(key)) continue;
				const cd = cooldownMap.get(key);
				if (cd && cd.until < soonest) soonest = cd.until;
			}
			if (!Number.isFinite(soonest)) {
				break;
			}
			const waitMs = Math.min(MAX_WAIT_FOR_COOLDOWN_MS, Math.max(0, soonest - Date.now()));
			if (waitMs <= 0 || waitMs >= MAX_WAIT_FOR_COOLDOWN_MS) {
				break;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
			continue;
		}

		tried.add(entryKey(entry));
		try {
			return await call(entry);
		} catch (error) {
			lastError = error;
			if (!isRetryable(error)) {
				throw error;
			}
			setCooldown(entry, cooldownMs);
			// Loop, try next entry.
		}
	}

	throw lastError ?? new Error("withFallbackChain: exhausted chain");
}
