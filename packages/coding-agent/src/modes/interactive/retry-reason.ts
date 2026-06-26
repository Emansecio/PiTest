/**
 * Classify an auto-retry's error message into a short, human reason for the retry
 * countdown ("Rate limited", "Overloaded", …). The `auto_retry_start` event
 * carries `errorMessage`, but the countdown used to discard it — leaving the user
 * staring at a paused timer with no idea whether to wait (transient overload) or
 * intervene (broken). Returns `undefined` when nothing matches, so the caller
 * keeps the original wording byte-identical (no misleading guess).
 *
 * Ordered most-specific-first. Display-only: a mislabel is cosmetic, never
 * affects backoff or the retry itself.
 */
export function classifyRetryReason(errorMessage: string | undefined): string | undefined {
	if (!errorMessage) return undefined;
	const m = errorMessage.toLowerCase();
	if (/\b429\b|rate.?limit|too many requests|quota|resource[_ ]exhausted/.test(m)) return "Rate limited";
	if (/overloaded|\b529\b|server is busy|at capacity/.test(m)) return "Overloaded";
	if (/timeout|timed out|timed-out|etimedout|deadline exceeded/.test(m)) return "Timed out";
	if (
		/econnreset|econnrefused|enotfound|eai_again|epipe|socket hang up|network|fetch failed|connection (closed|reset|refused|error)|stream (closed|error)|premature close/.test(
			m,
		)
	) {
		return "Network error";
	}
	if (/\b5\d\d\b|server error|internal server|bad gateway|service unavailable/.test(m)) return "Server error";
	return undefined;
}
