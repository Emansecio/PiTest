/**
 * Shared parsing for boolean-ish environment flags so every call site agrees on
 * what counts as "on" (e.g. PIT_OFFLINE=0 must not be treated as enabled).
 */

/** Truthy for "1", "true", or "yes" (case-insensitive); falsy otherwise. */
export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

/** True when startup network operations are disabled via PIT_OFFLINE (or --offline, which sets it). */
export function isOfflineMode(): boolean {
	return isTruthyEnvFlag(process.env.PIT_OFFLINE);
}

/** Default idle keep-alive for the global undici dispatcher (ms). */
const DEFAULT_KEEPALIVE_MS = 60_000;
/** undici's own keepAliveMaxTimeout default; caps the server keep-alive hint. */
const UNDICI_KEEPALIVE_MAX_DEFAULT_MS = 600_000;

/**
 * Keep-alive tuning for the global undici dispatcher. undici's default
 * keepAliveTimeout (4s) is shorter than the typical gap between agent turns
 * (tool runs + render + typing), so nearly every turn re-paid DNS+TCP+TLS
 * (+40–200ms TTFT). Hold idle sockets for 60s instead.
 *
 * - `PIT_KEEPALIVE_MS`: numeric override of the idle keep-alive (ms, ≥ 1).
 * - `PIT_NO_KEEPALIVE_TUNING=1`: disables the tuning entirely (undici defaults).
 *
 * Invalid/NaN/non-positive overrides fall back to the 60s default (fail-open).
 * `keepAliveMaxTimeout` is kept ≥ `keepAliveTimeout` (undici requires it to cap
 * the server's keep-alive hint, and rejects max < timeout).
 */
export function resolveKeepAliveOptions(
	env: NodeJS.ProcessEnv = process.env,
): { keepAliveTimeout: number; keepAliveMaxTimeout: number } | undefined {
	if (isTruthyEnvFlag(env.PIT_NO_KEEPALIVE_TUNING)) return undefined;
	let keepAliveTimeout = DEFAULT_KEEPALIVE_MS;
	const raw = env.PIT_KEEPALIVE_MS;
	if (raw !== undefined && raw.trim() !== "") {
		const parsed = Number(raw);
		if (Number.isFinite(parsed) && parsed >= 1) keepAliveTimeout = Math.floor(parsed);
	}
	return {
		keepAliveTimeout,
		keepAliveMaxTimeout: Math.max(keepAliveTimeout, UNDICI_KEEPALIVE_MAX_DEFAULT_MS),
	};
}

/**
 * True when decorative motion should be suppressed: color breathing, settle
 * color-eases, the icon crossfade, the "Thinking…" pulse, the streaming reveal,
 * and live spinner glyphs all snap to a static frame (frame 0). Elapsed counters
 * and per-second clocks keep updating. Opt-in via PIT_NO_MOTION /
 * PIT_REDUCED_MOTION, or a `TERM=dumb` terminal that can't render it cleanly.
 */
export function isReducedMotion(): boolean {
	return (
		isTruthyEnvFlag(process.env.PIT_NO_MOTION) ||
		isTruthyEnvFlag(process.env.PIT_REDUCED_MOTION) ||
		process.env.TERM === "dumb"
	);
}
