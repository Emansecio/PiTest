/**
 * Stable structural fingerprint of tool args (sorted object keys).
 * Used by the agent loop to detect in-place beforeToolCall mutations.
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
