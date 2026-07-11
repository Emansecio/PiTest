/**
 * In-memory tool-call telemetry per session.
 *
 * Counts calls and errors per tool, plus the top error messages so operators
 * can see which tool/error combinations dominate a session. Bounded so a
 * pathological loop cannot leak memory: error fingerprints fall back to a
 * fixed "other" bucket once the per-tool fingerprint cap is reached.
 */

import { sliceSafe } from "../utils/surrogate.ts";

const DEFAULT_MAX_ERROR_FINGERPRINTS_PER_TOOL = 20;
const DEFAULT_ERROR_FINGERPRINT_LENGTH = 120;
const DEFAULT_SEQUENCE_WINDOW = 16;
const DEFAULT_DOOM_LOOP_THRESHOLD = 4;

/**
 * Longest cycle period the repeating-pattern detector scans for, e.g. 5 catches
 * a [read,edit,bash,lsp,test] cycle. Kept small so the scan stays O(cap*window).
 */
const REPEATING_PATTERN_MAX_PERIOD = 5;
/**
 * Hard cap on how many trailing entries the repeating-pattern scan considers,
 * independent of the (larger) sequence window, so the cost is bounded even if
 * the ring grows. Twenty entries hold 5 reps of a length-4 cycle.
 */
const REPEATING_PATTERN_WINDOW = 20;

const RE_WHITESPACE = /\s+/g;
const RE_DIGITS = /\d+/g;

export interface ToolCallStatsOptions {
	maxErrorFingerprintsPerTool?: number;
	errorFingerprintLength?: number;
	/** How many recent calls to retain for doom-loop detection. */
	sequenceWindow?: number;
	/** Consecutive identical (toolName,argsFingerprint) calls that count as a loop. */
	doomLoopThreshold?: number;
}

export interface ToolCallSequenceEntry {
	toolName: string;
	argsFingerprint: string;
	/**
	 * The originating tool call id, when known. Lets {@link ToolCallStats.recordInvocationResult}
	 * backfill the result onto the CORRECT ring entry instead of positionally
	 * (ringHead-1), which is wrong under parallel tool execution where all starts
	 * are recorded before any end fires.
	 */
	toolCallId?: string;
	/**
	 * Hash of the tool RESULT, backfilled at tool_execution_end. Undefined while
	 * the call is in flight (recorded at start, result not yet known). The
	 * result-aware doom-loop count treats two calls as the "same" only when name,
	 * args AND result hash all match — so a tool that makes real progress with
	 * identical args but a NEW result each step (e.g. debugger stepping) is not a
	 * loop, while a call that keeps producing the same error is.
	 */
	resultHash?: string;
	/**
	 * Whether the backfilled result was an error. Stamped alongside `resultHash` at
	 * tool_execution_end. Used by {@link ToolCallStats.getConsecutiveSimilarResultOnlyCount}
	 * to gate the result-only thrash signal on errors (a run of identical SUCCESS
	 * results is progress, not a loop). Undefined while the call is in flight.
	 */
	isError?: boolean;
}

export interface ToolErrorFingerprint {
	message: string;
	count: number;
}

/**
 * Result of {@link ToolCallStats.getRepeatingPatternCount}: the longest
 * multi-tool cycle that repeats at the tail of the sequence window.
 * `patternLength` is the cycle period (number of distinct calls per cycle) and
 * `repetitions` is how many back-to-back copies of that cycle anchor the end of
 * the window. `{ patternLength: 0, repetitions: 0 }` means no repeating cycle.
 */
export interface RepeatingPatternMatch {
	patternLength: number;
	repetitions: number;
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
	private readonly doomLoopThreshold: number;
	private readonly ringBuffer: (ToolCallSequenceEntry | undefined)[];
	private ringHead = 0;
	private ringSize = 0;

	constructor(options?: ToolCallStatsOptions) {
		this.maxFingerprints = options?.maxErrorFingerprintsPerTool ?? DEFAULT_MAX_ERROR_FINGERPRINTS_PER_TOOL;
		this.fingerprintLength = options?.errorFingerprintLength ?? DEFAULT_ERROR_FINGERPRINT_LENGTH;
		this.sequenceWindow = options?.sequenceWindow ?? DEFAULT_SEQUENCE_WINDOW;
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
	recordInvocation(toolName: string, argsFingerprint: string, toolCallId?: string): void {
		this.ringBuffer[this.ringHead] = { toolName, argsFingerprint, toolCallId };
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

	/**
	 * Attach a result hash to the most recent invocation (the call that just
	 * finished). No-op when the window is empty. Pairs with {@link recordInvocation}:
	 * the start records (name, args) with no result, end backfills the result hash so
	 * {@link getConsecutiveSimilarResultCount} can distinguish a true loop (same
	 * result) from real progress (new result each call).
	 */
	recordInvocationResult(resultHash: string, isError: boolean, toolCallId?: string): void {
		if (this.ringSize === 0) return;
		// Locate the entry to stamp. With a toolCallId, find the matching invocation
		// (scanning back from the most recent) so parallel batches — where all starts
		// are recorded before any end fires — stamp the right call rather than always
		// the last-pushed entry. Without an id, fall back to ringHead-1 (correct for
		// strictly sequential start/end interleaving).
		let target: ToolCallSequenceEntry | undefined;
		if (toolCallId !== undefined) {
			for (let i = 0; i < this.ringSize; i++) {
				const idx = (this.ringHead - 1 - i + this.sequenceWindow * 2) % this.sequenceWindow;
				const entry = this.ringBuffer[idx];
				if (entry && entry.toolCallId === toolCallId) {
					target = entry;
					break;
				}
			}
		} else {
			const lastIdx = (this.ringHead - 1 + this.sequenceWindow) % this.sequenceWindow;
			target = this.ringBuffer[lastIdx];
		}
		if (target) {
			target.resultHash = resultHash;
			target.isError = isError;
		}
	}

	/**
	 * Like {@link getConsecutiveSimilarCount} but also requires the RESULT hash to
	 * match. Counts the trailing run of entries that share the most recent entry's
	 * (toolName, argsFingerprint, resultHash). An entry whose result hash is still
	 * undefined (in flight) only matches another undefined one, so this is meant to
	 * be read at tool_execution_end after {@link recordInvocationResult} has stamped
	 * the just-finished call. Returns 0 when the window is empty.
	 */
	getConsecutiveSimilarResultCount(): number {
		if (this.ringSize === 0) return 0;
		const lastIdx = (this.ringHead - 1 + this.sequenceWindow) % this.sequenceWindow;
		const last = this.ringBuffer[lastIdx]!;
		let count = 0;
		for (let i = 0; i < this.ringSize; i++) {
			const idx = (this.ringHead - 1 - i + this.sequenceWindow * 2) % this.sequenceWindow;
			const entry = this.ringBuffer[idx]!;
			if (entry.toolName !== last.toolName || entry.argsFingerprint !== last.argsFingerprint) break;
			if (entry.resultHash !== last.resultHash) break;
			count++;
		}
		return count;
	}

	/**
	 * Count the trailing run of entries that share the most recent entry's RESULT
	 * hash, IGNORING toolName/argsFingerprint — and ONLY when that last result was an
	 * error. This catches the "thrash" loop the args-keyed counts miss: the model
	 * tweaks the arguments every call (shifted offset, slightly different oldText)
	 * but keeps getting the SAME error, so {@link getConsecutiveSimilarResultCount}
	 * resets each call and never climbs. Returns 0 on an empty window or when the
	 * last result is a success/in-flight (a run of identical SUCCESSES is progress,
	 * not a loop). Read at tool_execution_end after {@link recordInvocationResult}.
	 */
	getConsecutiveSimilarResultOnlyCount(): number {
		if (this.ringSize === 0) return 0;
		const lastIdx = (this.ringHead - 1 + this.sequenceWindow) % this.sequenceWindow;
		const last = this.ringBuffer[lastIdx]!;
		if (last.isError !== true) return 0;
		let count = 0;
		for (let i = 0; i < this.ringSize; i++) {
			const idx = (this.ringHead - 1 - i + this.sequenceWindow * 2) % this.sequenceWindow;
			const entry = this.ringBuffer[idx]!;
			if (entry.resultHash !== last.resultHash) break;
			count++;
		}
		return count;
	}

	/**
	 * Longest repeating multi-tool CYCLE anchored at the end of the sequence
	 * window — the "productive-looking" loop the consecutive-identical detector
	 * misses (e.g. [read,edit,bash] run four times in a row). Complementary to
	 * {@link getConsecutiveSimilarCount}: that one catches the SAME call repeated,
	 * this catches a block of DIFFERENT calls repeated.
	 *
	 * Each entry is keyed by (toolName, argsFingerprint) so a cycle that makes real
	 * progress — same tool sequence but a different file/arg each pass — does NOT
	 * register as a loop (its blocks differ). For every period `p` in
	 * 2..{@link REPEATING_PATTERN_MAX_PERIOD} it counts how many copies of the
	 * final block-of-size-`p` repeat walking backwards, and returns the match with
	 * the most repetitions (ties broken toward the longer cycle, which is the more
	 * specific/informative pattern). Considers only the last
	 * {@link REPEATING_PATTERN_WINDOW} entries, so the cost is O(cap*window).
	 *
	 * A pure period-1 cycle (identical call repeated) is intentionally NOT reported
	 * here — that is the consecutive-identical detector's job; this method requires
	 * `patternLength >= 2`. Returns `{ patternLength: 0, repetitions: 0 }` when no
	 * cycle of period >= 2 repeats at least twice.
	 */
	getRepeatingPatternCount(): RepeatingPatternMatch {
		const none: RepeatingPatternMatch = { patternLength: 0, repetitions: 0 };
		if (this.ringSize < 4) return none;
		// Most-recent-first keys, capped to the pattern window (anti-OOM, bounded cost).
		const limit = Math.min(this.ringSize, REPEATING_PATTERN_WINDOW);
		// NUL-separated (toolName, argsFingerprint) keys, collision-safe even if a
		// tool name contains spaces; most-recent-first.
		const keys: string[] = new Array(limit);
		for (let i = 0; i < limit; i++) {
			const idx = (this.ringHead - 1 - i + this.sequenceWindow * 2) % this.sequenceWindow;
			const entry = this.ringBuffer[idx]!;
			keys[i] = `${entry.toolName}\u0000${entry.argsFingerprint}`;
		}
		let best = none;
		const maxPeriod = Math.min(REPEATING_PATTERN_MAX_PERIOD, Math.floor(limit / 2));
		for (let period = 2; period <= maxPeriod; period++) {
			// Walk backwards comparing each block of `period` keys to the final block.
			// `reps` counts how many consecutive copies of the final block match.
			let reps = 1;
			let aligned = true;
			while (aligned && (reps + 1) * period <= limit) {
				const base = reps * period;
				for (let j = 0; j < period; j++) {
					if (keys[j] !== keys[base + j]) {
						aligned = false;
						break;
					}
				}
				if (aligned) reps++;
			}
			// A period that is itself made of a smaller repeating unit (e.g. period 4
			// over [a,b,a,b]) is a degenerate restatement of the shorter cycle; the
			// shorter period already captured it with >= the same reps, so prefer
			// fewer-but-real cycles by requiring reps >= 2 and taking max reps, ties
			// toward longer (more specific) period.
			//
			// Distinctness guard: the cycle block must contain >= 2 distinct keys.
			// An all-identical block (e.g. [a,a]) is just the SAME call repeated — a
			// period-1 loop the consecutive-identical detector owns — so excluding it
			// here keeps the two detectors strictly complementary and avoids a
			// double-fire on a pure identical loop.
			if (reps >= 2 && blockHasDistinctKeys(keys, period)) {
				const better = reps > best.repetitions || (reps === best.repetitions && period > best.patternLength);
				if (better) best = { patternLength: period, repetitions: reps };
			}
		}
		return best;
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
		return `${sliceSafe(collapsed, 0, this.fingerprintLength)}\u2026`;
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
	return `${sliceSafe(serialized, 0, maxChars)}…`;
}

/**
 * Collision-resistant fingerprint for doom-loop detection. Unlike
 * {@link fingerprintToolArgs} — which caps each string value and the total
 * length for readable telemetry — this hashes the FULL stable serialization, so
 * two distinct calls that merely share a long common prefix (e.g. two different
 * `git log … <ref>` bash commands, or two long `node -e` scripts) do NOT
 * collapse into the same bucket and trigger a false consecutive-loop streak. The
 * hash also keeps the ring-buffer key small regardless of argument size.
 *
 * WeakMap identity cache: when the same args object is fingerprinted again
 * (common on retries / stats paths), skip the full stringify+hash.
 */
const exactArgsFingerprintCache = new WeakMap<object, string>();

export function fingerprintToolArgsExact(args: unknown): string {
	if (typeof args === "object" && args !== null) {
		const cached = exactArgsFingerprintCache.get(args as object);
		if (cached !== undefined) return cached;
	}
	let serialized: string;
	try {
		serialized = stableStringify(args, Number.POSITIVE_INFINITY);
	} catch {
		serialized = String(args);
	}
	const hash = hashString(serialized);
	if (typeof args === "object" && args !== null) {
		exactArgsFingerprintCache.set(args as object, hash);
	}
	return hash;
}

/**
 * Hash of a tool RESULT for doom-loop result-awareness. Folds the error flag and
 * the result's text content into one FNV-1a hash so two calls with identical
 * output collapse (a real loop) while a call that returns new output each time
 * (e.g. debugger stepping) gets a fresh hash (real progress). Non-text parts are
 * keyed by type+order so an image/diff payload still differentiates results.
 */
export function fingerprintToolResult(
	result: { content?: Array<{ type: string; text?: string }> } | undefined,
	isError: boolean,
): string {
	const parts: unknown[] = [isError ? 1 : 0];
	for (const part of result?.content ?? []) {
		if (part.type === "text" && typeof part.text === "string") {
			parts.push(["t", part.text]);
		} else {
			parts.push([part.type]);
		}
	}
	let serialized: string;
	try {
		serialized = stableStringify(parts, Number.POSITIVE_INFINITY);
	} catch {
		serialized = String(parts);
	}
	return hashString(serialized);
}

/**
 * True when the first `period` keys (the trailing cycle block, most-recent-first)
 * are not all identical. Used by {@link ToolCallStats.getRepeatingPatternCount} to
 * reject all-same blocks, which are period-1 identical loops in disguise.
 */
function blockHasDistinctKeys(keys: readonly string[], period: number): boolean {
	const first = keys[0];
	for (let j = 1; j < period; j++) {
		if (keys[j] !== first) return true;
	}
	return false;
}

/**
 * FNV-1a 32-bit hash, hex-encoded. Dependency-free and ample for distinguishing
 * tool-call argument sets within the 16-slot doom-loop ring buffer.
 */
function hashString(input: string): string {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}

const STRING_VALUE_CAP = 100;

function stableStringify(value: unknown, stringValueCap = STRING_VALUE_CAP): string {
	const seen = new WeakSet<object>();
	const visit = (input: unknown): unknown => {
		if (input === null || typeof input !== "object") {
			if (typeof input === "string" && input.length > stringValueCap) {
				return `${sliceSafe(input, 0, stringValueCap)}…`;
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
