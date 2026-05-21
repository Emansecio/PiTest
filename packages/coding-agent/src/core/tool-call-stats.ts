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
const DEFAULT_SEQUENCE_WINDOW = 16;
const DEFAULT_ARGS_FINGERPRINT_LENGTH = 200;
const DEFAULT_DOOM_LOOP_THRESHOLD = 4;

const RE_WHITESPACE = /\s+/g;
const RE_DIGITS = /\d+/g;

export interface ToolCallStatsOptions {
	maxErrorFingerprintsPerTool?: number;
	errorFingerprintLength?: number;
	/** How many recent calls to retain for doom-loop detection. */
	sequenceWindow?: number;
	/** Max characters of args fingerprint after JSON stable-serialize. */
	argsFingerprintLength?: number;
	/** Consecutive identical (toolName,argsFingerprint) calls that count as a loop. */
	doomLoopThreshold?: number;
}

export interface ToolCallSequenceEntry {
	toolName: string;
	argsFingerprint: string;
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
	private readonly sequenceWindow: number;
	private readonly argsFingerprintLength: number;
	private readonly doomLoopThreshold: number;
	private readonly ringBuffer: (ToolCallSequenceEntry | undefined)[];
	private ringHead = 0;
	private ringSize = 0;

	constructor(options?: ToolCallStatsOptions) {
		this.maxFingerprints = options?.maxErrorFingerprintsPerTool ?? DEFAULT_MAX_ERROR_FINGERPRINTS_PER_TOOL;
		this.fingerprintLength = options?.errorFingerprintLength ?? DEFAULT_ERROR_FINGERPRINT_LENGTH;
		this.sequenceWindow = options?.sequenceWindow ?? DEFAULT_SEQUENCE_WINDOW;
		this.argsFingerprintLength = options?.argsFingerprintLength ?? DEFAULT_ARGS_FINGERPRINT_LENGTH;
		this.doomLoopThreshold = options?.doomLoopThreshold ?? DEFAULT_DOOM_LOOP_THRESHOLD;
		this.ringBuffer = new Array(this.sequenceWindow);
	}

	/** Threshold at which `isInDoomLoop()` returns true. Exposed for callers building reminders. */
	get loopThreshold(): number {
		return this.doomLoopThreshold;
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
		this.ringBuffer.fill(undefined);
		this.ringHead = 0;
		this.ringSize = 0;
	}

	/**
	 * Record a tool invocation in the sequence window. Independent of `record()` so
	 * callers can capture invocations even when outcomes are not yet known (e.g. on
	 * `tool_execution_start`). Args fingerprint should be produced via {@link fingerprintToolArgs}.
	 */
	recordInvocation(toolName: string, argsFingerprint: string): void {
		this.ringBuffer[this.ringHead] = { toolName, argsFingerprint };
		this.ringHead = (this.ringHead + 1) % this.sequenceWindow;
		if (this.ringSize < this.sequenceWindow) this.ringSize++;
	}

	/**
	 * Count of trailing entries in the sequence window with the same (toolName,argsFingerprint)
	 * as the most recent invocation. Returns 0 when the window is empty.
	 */
	getConsecutiveSimilarCount(): number {
		if (this.ringSize === 0) return 0;
		const lastIdx = (this.ringHead - 1 + this.sequenceWindow) % this.sequenceWindow;
		const last = this.ringBuffer[lastIdx]!;
		let count = 0;
		for (let i = 0; i < this.ringSize; i++) {
			const idx = (this.ringHead - 1 - i + this.sequenceWindow * 2) % this.sequenceWindow;
			const entry = this.ringBuffer[idx]!;
			if (entry.toolName !== last.toolName || entry.argsFingerprint !== last.argsFingerprint) break;
			count++;
		}
		return count;
	}

	/** True when consecutive identical invocations reach the configured threshold. */
	isInDoomLoop(threshold?: number): boolean {
		const limit = threshold ?? this.doomLoopThreshold;
		return this.getConsecutiveSimilarCount() >= limit;
	}

	/** Read-only view of the sequence window. Mainly for diagnostics and tests. */
	getSequence(): readonly ToolCallSequenceEntry[] {
		const result: ToolCallSequenceEntry[] = [];
		for (let i = 0; i < this.ringSize; i++) {
			const idx = (this.ringHead - this.ringSize + i + this.sequenceWindow * 2) % this.sequenceWindow;
			result.push(this.ringBuffer[idx]!);
		}
		return result;
	}

	/**
	 * Clear only the sequence window (preserve call counts and error fingerprints).
	 * Use after firing a doom-loop reminder so the next identical call starts a
	 * fresh streak instead of re-triggering immediately.
	 */
	resetSequence(): void {
		this.ringBuffer.fill(undefined);
		this.ringHead = 0;
		this.ringSize = 0;
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
		RE_WHITESPACE.lastIndex = 0;
		RE_DIGITS.lastIndex = 0;
		const collapsed = message.replace(RE_WHITESPACE, " ").replace(RE_DIGITS, "N").trim();
		if (collapsed.length === 0) return undefined;
		if (collapsed.length <= this.fingerprintLength) return collapsed;
		return `${collapsed.slice(0, this.fingerprintLength)}\u2026`;
	}
}

/**
 * Stable, length-capped fingerprint for tool arguments. Sorts object keys so
 * semantically identical calls collapse to the same bucket regardless of input
 * key order. Falls back to `String(args)` when JSON serialization throws
 * (cyclic, BigInt, etc.).
 */
export function fingerprintToolArgs(args: unknown, maxChars = 200): string {
	let serialized: string;
	try {
		serialized = stableStringify(args);
	} catch {
		serialized = String(args);
	}
	if (serialized.length <= maxChars) return serialized;
	return `${serialized.slice(0, maxChars)}…`;
}

const STRING_VALUE_CAP = 100;

function stableStringify(value: unknown): string {
	const seen = new WeakSet<object>();
	const visit = (input: unknown): unknown => {
		if (input === null || typeof input !== "object") {
			if (typeof input === "string" && input.length > STRING_VALUE_CAP) {
				return `${input.slice(0, STRING_VALUE_CAP)}…`;
			}
			return input;
		}
		if (seen.has(input as object)) return "[Circular]";
		seen.add(input as object);
		if (Array.isArray(input)) return input.map(visit);
		const obj = input as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(obj).sort()) {
			out[key] = visit(obj[key]);
		}
		return out;
	};
	return JSON.stringify(visit(value));
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
