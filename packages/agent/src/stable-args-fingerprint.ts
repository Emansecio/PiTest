/**
 * Stable structural fingerprint of tool args (sorted object keys).
 *
 * No longer used on the agent-loop hot path (beforeToolCall mutations are
 * detected by the Proxy/markArgsMutated flag and revalidated via the
 * validator.Check fast path); kept as public API for embedders.
 */
export function stableArgsFingerprint(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableArgsFingerprint).join(",")}]`;
	}
	if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableArgsFingerprint(record[key])}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
