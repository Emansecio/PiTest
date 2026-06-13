// Header-aware retry helpers shared across providers that roll their own fetch
// retry loop (e.g. the Codex transport). Providers that delegate retries to a
// vendor SDK (@anthropic-ai/sdk, openai, @google/genai) already honor
// `retry-after` / `retry-after-ms` internally and must NOT layer this on top —
// that would double-count the server-requested delay.
//
// The goal is to honor the server's backpressure verbatim: when a 429/5xx comes
// back with a `retry-after-ms` or `retry-after` header, we wait exactly as long
// as the server asked instead of guessing with exponential backoff. Honoring it
// is what keeps a fan-out of subagents from dog-piling a rate-limited endpoint
// and dying on repeated 429s.

/**
 * Minimal view of a response headers bag. Matches the WHATWG `Headers` `.get`
 * contract (returns the value or `null`) so callers can pass `response.headers`
 * directly without adapting.
 */
export interface RetryHeaderLookup {
	get(name: string): string | null;
}

/** Statuses we always retry: rate-limit plus the transient 5xx family. */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * Whether an HTTP status should be retried. 429 (rate limit) and the transient
 * 5xx family (500/502/503/504) — 5xx is always retryable per the contract.
 */
export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUSES.has(status);
}

/**
 * Parse a retry delay (in milliseconds) from response headers, honoring the
 * server's requested backpressure. Returns `null` when no usable hint is
 * present so the caller falls back to its own backoff.
 *
 * Precedence (matches the OpenAI/Codex convention):
 *  1. `retry-after-ms` — a millisecond integer (non-standard, OpenAI-specific).
 *  2. `retry-after` — either a delay in seconds (RFC 7231 delay-seconds) or an
 *     HTTP-date (RFC 7231 IMF-fixdate); parsed via the platform `Date.parse`.
 *
 * Garbage / unparseable values yield `null`. A past HTTP-date clamps to 0.
 *
 * @param headers Header bag exposing `.get` (e.g. a `fetch` `Response.headers`).
 * @param now Injectable clock (ms epoch) so HTTP-date math is deterministic in
 *   tests. Defaults to `Date.now`.
 */
export function parseRetryAfter(headers: RetryHeaderLookup, now: () => number = Date.now): number | null {
	const retryAfterMs = headers.get("retry-after-ms");
	if (retryAfterMs !== null) {
		const millis = Number(retryAfterMs);
		if (Number.isFinite(millis)) {
			return Math.max(0, millis);
		}
	}

	const retryAfter = headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) {
			return Math.max(0, seconds * 1000);
		}
		const date = Date.parse(retryAfter);
		if (!Number.isNaN(date)) {
			return Math.max(0, date - now());
		}
	}

	return null;
}

/**
 * Tunables + injectable nondeterminism for {@link computeRetryDelay}. The clock
 * and RNG are injectable so the jitter is deterministic under test — the Pit
 * gate bans the global `Date.now`/`Math.random` from test paths.
 */
export interface RetryDelayOptions {
	/** Base delay for attempt 0, doubled per attempt. Default: 1000ms. */
	baseDelayMs?: number;
	/** Upper clamp on the computed (non-server) backoff. Default: unbounded. */
	maxDelayMs?: number;
	/** Random source in [0, 1) for jitter. Default: `Math.random`. */
	random?: () => number;
}

/**
 * Compute how long to wait before the next retry.
 *
 * When the server hands us a delay (`retryAfterMs`, from
 * {@link parseRetryAfter}), it is honored verbatim — the server knows its own
 * rate-limit window better than our heuristic. Otherwise fall back to
 * exponential backoff with full jitter: `base * 2^attempt * (0.5 + random())`,
 * which spreads concurrent retries so a fan-out doesn't thunder-herd.
 *
 * @param attempt Zero-based retry attempt index.
 * @param retryAfterMs Server-requested delay in ms, or `null` for backoff.
 * @param opts Tunables + injectable RNG.
 */
export function computeRetryDelay(attempt: number, retryAfterMs: number | null, opts: RetryDelayOptions = {}): number {
	if (retryAfterMs !== null) {
		return Math.max(0, retryAfterMs);
	}

	const baseDelayMs = opts.baseDelayMs ?? 1000;
	const random = opts.random ?? Math.random;
	const delay = baseDelayMs * 2 ** attempt * (0.5 + random());
	const clamped = opts.maxDelayMs !== undefined ? Math.min(delay, opts.maxDelayMs) : delay;
	return Math.max(0, clamped);
}
