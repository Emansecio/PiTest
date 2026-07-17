/**
 * Turn-over-turn memoization for {@link sanitizeSurrogates} during Anthropic
 * message conversion.
 *
 * WHY: convertMessages sanitizes every text / thinking / tool-result block of the
 * WHOLE transcript on EVERY pre-send. Even with the zero-alloc fast path in
 * sanitizeSurrogates, that is an O(total context chars) scan per turn, and the
 * historical blocks are byte-identical turn-over-turn.
 *
 * CORRECTNESS: keys are the stable enclosing objects (the transformed block, the
 * user message, or the tool-result content array). In the same-model fast path
 * transformMessages returns messages verbatim, so these objects — and the string
 * refs inside them — keep identity across turns; even the slow path copies text
 * by reference (`text: block.text`). We never trust the object alone: every hit
 * is revalidated by comparing the stored input string(s) by reference (===). If a
 * block is mutated in place or its text replaced, the stored ref no longer
 * matches and we re-sanitize. A WeakMap lets keys be GC'd when messages leave the
 * transcript (compaction / prune), so there is no unbounded growth.
 *
 * Only cached values that are safe to share are cached: sanitized strings
 * (immutable). We never cache mutable block arrays.
 */

import { sanitizeSurrogates } from "./sanitize-unicode.ts";

interface StringMemoEntry {
	input: string;
	output: string;
}

const stringMemo = new WeakMap<object, StringMemoEntry>();

/**
 * Memoized {@link sanitizeSurrogates} for a single string field, keyed on the
 * stable object that owns it (the block or message). Revalidated by string
 * reference, so replacing/mutating the field re-sanitizes. O(1) on a hit.
 */
export function sanitizeSurrogatesMemo(keyObj: object, text: string): string {
	const cached = stringMemo.get(keyObj);
	if (cached !== undefined && cached.input === text) {
		return cached.output;
	}
	const output = sanitizeSurrogates(text);
	stringMemo.set(keyObj, { input: text, output });
	return output;
}

interface JoinedMemoEntry {
	/** Per-part string refs captured at store time — revalidated by identity. */
	parts: readonly string[];
	output: string;
}

const joinedMemo = new WeakMap<object, JoinedMemoEntry>();

/**
 * Memoized `sanitizeSurrogates(parts.join("\n"))`, keyed on the stable content
 * array. The join produces a fresh string each call, so we cannot revalidate on
 * the joined result; instead we compare the individual part string refs — O(number
 * of blocks), never O(total chars). Bulletproof against both array replacement
 * (new key → miss) and in-place block edits (a part ref differs → miss). Returns
 * an immutable string, safe to share.
 */
export function sanitizeJoinedTextMemo(keyObj: object, parts: string[]): string {
	const cached = joinedMemo.get(keyObj);
	if (cached !== undefined && samePartRefs(cached.parts, parts)) {
		return cached.output;
	}
	const output = sanitizeSurrogates(parts.join("\n"));
	joinedMemo.set(keyObj, { parts: parts.slice(), output });
	return output;
}

function samePartRefs(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}
