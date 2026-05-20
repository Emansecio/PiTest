/**
 * In-memory tool-call telemetry per session.
 *
 * Counts calls and errors per tool, plus the top error messages so operators
 * can see which tool/error combinations dominate a session. Bounded so a
 * pathological loop cannot leak memory: error fingerprints fall back to a
 * fixed "other" bucket once the per-tool fingerprint cap is reached.
 */

const DEFAULT_MAX_ERROR_FINGERPRINTS_PER_TOOL = 20;
const DEFAULT_ERROR_FINGERPRINT_LENGTH = 120;

export interface ToolCallStatsOptions {
	maxErrorFingerprintsPerTool?: number;
	errorFingerprintLength?: number;
}

export interface ToolErrorFingerprint {
	message: string;
	count: number;
}

export interface ToolStat {
	tool: string;
	calls: number;
	errors: number;
	errorRate: number;
	topErrors: ToolErrorFingerprint[];
}

interface ToolBucket {
	calls: number;
	errors: number;
	errorFingerprints: Map<string, number>;
	overflowedErrorBucket: number;
}

export class ToolCallStats {
	private readonly buckets = new Map<string, ToolBucket>();
	private readonly maxFingerprints: number;
	private readonly fingerprintLength: number;

	constructor(options?: ToolCallStatsOptions) {
		this.maxFingerprints = options?.maxErrorFingerprintsPerTool ?? DEFAULT_MAX_ERROR_FINGERPRINTS_PER_TOOL;
		this.fingerprintLength = options?.errorFingerprintLength ?? DEFAULT_ERROR_FINGERPRINT_LENGTH;
	}

	/**
	 * Record one finished tool call. `errorMessage` is the human-readable text
	 * extracted from the failing tool result; pass undefined for success.
	 */
	record(toolName: string, isError: boolean, errorMessage?: string): void {
		const bucket = this.getOrCreateBucket(toolName);
		bucket.calls += 1;
		if (!isError) return;
		bucket.errors += 1;
		const fingerprint = this.normalizeFingerprint(errorMessage);
		if (fingerprint === undefined) return;
		const existing = bucket.errorFingerprints.get(fingerprint);
		if (existing !== undefined) {
			bucket.errorFingerprints.set(fingerprint, existing + 1);
			return;
		}
		if (bucket.errorFingerprints.size >= this.maxFingerprints) {
			bucket.overflowedErrorBucket += 1;
			return;
		}
		bucket.errorFingerprints.set(fingerprint, 1);
	}

	/** Snapshot sorted by descending error count, then by call count. */
	snapshot(): ToolStat[] {
		const stats: ToolStat[] = [];
		for (const [tool, bucket] of this.buckets) {
			const topErrors: ToolErrorFingerprint[] = Array.from(bucket.errorFingerprints.entries())
				.map(([message, count]) => ({ message, count }))
				.sort((a, b) => b.count - a.count);
			if (bucket.overflowedErrorBucket > 0) {
				topErrors.push({ message: "<other>", count: bucket.overflowedErrorBucket });
			}
			stats.push({
				tool,
				calls: bucket.calls,
				errors: bucket.errors,
				errorRate: bucket.calls === 0 ? 0 : bucket.errors / bucket.calls,
				topErrors,
			});
		}
		return stats.sort((a, b) => {
			if (b.errors !== a.errors) return b.errors - a.errors;
			return b.calls - a.calls;
		});
	}

	/** Reset all counters. Used by tests and on session reset flows. */
	reset(): void {
		this.buckets.clear();
	}

	private getOrCreateBucket(toolName: string): ToolBucket {
		const existing = this.buckets.get(toolName);
		if (existing) return existing;
		const created: ToolBucket = {
			calls: 0,
			errors: 0,
			errorFingerprints: new Map(),
			overflowedErrorBucket: 0,
		};
		this.buckets.set(toolName, created);
		return created;
	}

	private normalizeFingerprint(message: string | undefined): string | undefined {
		if (!message) return undefined;
		// Collapse whitespace, strip path/line numerics, cap length so distinct
		// runs of the same error fold into one bucket.
		const collapsed = message.replace(/\s+/g, " ").replace(/\d+/g, "N").trim();
		if (collapsed.length === 0) return undefined;
		if (collapsed.length <= this.fingerprintLength) return collapsed;
		return `${collapsed.slice(0, this.fingerprintLength)}\u2026`;
	}
}

/**
 * Helper to pull a plain-text error message out of a tool result's content
 * array. Returns the joined `text` parts or undefined when the result has none.
 */
export function extractErrorMessage(content: Array<{ type: string; text?: string }> | undefined): string | undefined {
	if (!content) return undefined;
	const parts = content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text);
	if (parts.length === 0) return undefined;
	return parts.join("\n");
}
