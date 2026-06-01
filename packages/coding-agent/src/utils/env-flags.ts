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
