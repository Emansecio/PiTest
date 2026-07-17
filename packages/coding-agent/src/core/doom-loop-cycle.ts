/**
 * Pure tail-cycle detector for the cyclic doom-loop guard.
 *
 * Catches the classic MULTI-STEP tool loop that the consecutive-identical
 * doom-loop (same call repeated) and the cross-error tracker (same error across
 * approaches) both miss: a block of DIFFERENT calls repeated back-to-back with no
 * progress — e.g. read(f)→edit(f)→bash(check) run three times in a row.
 *
 * The algorithm mirrors forgecode's `count_recent_pattern_repetitions`
 * (doom_loop.rs): for each candidate period `p`, walk BACKWARDS from the tail and
 * count how many consecutive copies of the final block-of-`p` match. Because the
 * scan is anchored at the END, earlier different history (exploration, setup)
 * never prevents detection — only the trailing run matters.
 *
 * Each entry is a stable per-call SIGNATURE (`toolName + hash(args)`), so a cycle
 * that makes real progress — same tool sequence but a different file/arg each pass
 * — has DIFFERENT signatures per block and does NOT register (its blocks differ).
 * That is also why period-1 read exploration [read(f1),read(f2),read(f3)] never
 * fires: three distinct signatures form no repeating block.
 *
 * Pure and dependency-free: callers pass the signature array and read the result.
 */

export interface TailCycleMatch {
	/** Cycle period — number of calls per repeated block. */
	period: number;
	/** How many back-to-back copies of the block anchor the tail (>= minRepetitions). */
	repetitions: number;
}

export interface DetectTailCycleOptions {
	/** Smallest period to scan. Default 1. Set 2 to exclude period-1 identical loops. */
	minPeriod?: number;
	/** Largest period to scan. Default `floor(len / minRepetitions)`; also hard-capped by it. */
	maxPeriod?: number;
	/** Minimum back-to-back copies that count as a loop. Default 3 (forge's 3×). Clamped to >= 2. */
	minRepetitions?: number;
	/**
	 * Reject a block whose entries are all identical — that is a period-1 loop in
	 * disguise, owned by the consecutive-identical detector. Default false.
	 */
	requireDistinctBlock?: boolean;
	/** Tie-break when two periods reach the same repetition count. Default "longer". */
	tieBreak?: "longer" | "shorter";
	/** Consider only the last N signatures (anti-OOM / bounded cost). Default: all. */
	maxEntries?: number;
}

/**
 * Detect a cycle repeating at the TAIL of `signatures` (chronological order,
 * oldest first). Returns the best match or null when no block of period in
 * `[minPeriod, maxPeriod]` repeats at least `minRepetitions` times at the end.
 */
export function detectTailCycle(signatures: readonly string[], opts?: DetectTailCycleOptions): TailCycleMatch | null {
	const minRepetitions = Math.max(2, Math.floor(opts?.minRepetitions ?? 3));
	const minPeriod = Math.max(1, Math.floor(opts?.minPeriod ?? 1));
	const requireDistinctBlock = opts?.requireDistinctBlock ?? false;
	const tieBreak = opts?.tieBreak ?? "longer";

	// Anchor at the tail: only the last `maxEntries` entries matter.
	const maxEntries = opts?.maxEntries;
	const start = maxEntries !== undefined && signatures.length > maxEntries ? signatures.length - maxEntries : 0;
	const len = signatures.length - start;
	if (len < minPeriod * minRepetitions) return null;

	// A block of period p must fit `minRepetitions` copies: p <= floor(len / minRepetitions).
	const periodCeiling = Math.floor(len / minRepetitions);
	const maxPeriod = Math.min(opts?.maxPeriod ?? periodCeiling, periodCeiling);

	let best: TailCycleMatch | null = null;
	for (let period = minPeriod; period <= maxPeriod; period++) {
		const reps = countTailRepetitions(signatures, start, len, period);
		if (reps < minRepetitions) continue;
		if (requireDistinctBlock && !blockHasDistinctEntries(signatures, start + len - period, period)) continue;
		if (best === null || reps > best.repetitions) {
			best = { period, repetitions: reps };
		} else if (reps === best.repetitions && tieBreak === "longer" && period > best.period) {
			best = { period, repetitions: reps };
		}
		// tieBreak "shorter": ascending scan already keeps the first (smallest) period.
	}
	return best;
}

/**
 * Count how many consecutive copies of the FINAL block-of-`period` match, walking
 * backwards from the tail. `start` is the offset of the considered window in
 * `signatures`; `len` is the window length. Returns >= 1.
 */
function countTailRepetitions(signatures: readonly string[], start: number, len: number, period: number): number {
	const tailBlockStart = start + len - period;
	let reps = 1;
	while ((reps + 1) * period <= len) {
		const blockStart = start + len - (reps + 1) * period;
		let matches = true;
		for (let j = 0; j < period; j++) {
			if (signatures[blockStart + j] !== signatures[tailBlockStart + j]) {
				matches = false;
				break;
			}
		}
		if (!matches) break;
		reps++;
	}
	return reps;
}

/**
 * Rotation-invariant key for a cycle's ordered entries. A repeating cycle detected
 * at the tail rotates phase as the window slides ([a,b,c] → [b,c,a] → [c,a,b]), so
 * dedup logic that must treat those as the SAME cycle keys on the lexicographically
 * smallest rotation. Preserves order (distinguishes [a,b,c] from [a,c,b]); only the
 * starting offset is normalised. Cheap — periods are small (<= a handful).
 */
export function canonicalCycleKey(entries: readonly string[]): string {
	const n = entries.length;
	if (n === 0) return "";
	let best: string | undefined;
	for (let offset = 0; offset < n; offset++) {
		const rotation: string[] = [];
		for (let j = 0; j < n; j++) {
			rotation.push(entries[(offset + j) % n]);
		}
		const joined = rotation.join("\n");
		if (best === undefined || joined < best) best = joined;
	}
	return best ?? "";
}

/** True when the `period` entries starting at `blockStart` are not all identical. */
function blockHasDistinctEntries(signatures: readonly string[], blockStart: number, period: number): boolean {
	const first = signatures[blockStart];
	for (let j = 1; j < period; j++) {
		if (signatures[blockStart + j] !== first) return true;
	}
	return false;
}
