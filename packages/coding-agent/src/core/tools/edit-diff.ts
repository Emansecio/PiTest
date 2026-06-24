/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile, stat } from "fs/promises";
import { sliceSafe } from "../../utils/surrogate.ts";
import { resolveToCwd } from "./path-utils.ts";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1) return "\n";
	if (crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

/**
 * Normalize text for fuzzy matching. Applies progressive transformations:
 * - Strip trailing whitespace from each line
 * - Normalize smart quotes to ASCII equivalents
 * - Normalize Unicode dashes/hyphens to ASCII hyphen
 * - Normalize special Unicode spaces to regular space
 */
const COMBINING_MARK_RE = /\p{M}/u;

function isHorizontalWs(ch: string): boolean {
	return ch === " " || ch === "\t" || ch === "\v" || ch === "\f";
}

/**
 * Fold a single character: smart quotes (U+2018-U+201F), dashes/hyphens
 * (U+2010-U+2015, U+2212), special spaces (U+00A0, U+2002-U+200A, U+202F,
 * U+205F, U+3000). Returns the char unchanged when it is not a fold target.
 */
function foldFuzzyChar(ch: string): string {
	const code = ch.charCodeAt(0);
	if (code >= 0x2018 && code <= 0x201b) return "'";
	if (code >= 0x201c && code <= 0x201f) return '"';
	if ((code >= 0x2010 && code <= 0x2015) || code === 0x2212) return "-";
	if (code === 0x00a0 || (code >= 0x2002 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000) {
		return " ";
	}
	return ch;
}

/**
 * Fuzzy-normalize `text` and return an index map projecting every normalized
 * code unit back to a byte offset in the ORIGINAL string: `map[k]` is the
 * original index that produced normalized char `k`, and `map[normalized.length]`
 * is `text.length` (sentinel). This lets a match found in normalized space be
 * spliced back onto the original content so regions OUTSIDE the match keep their
 * exact original bytes (smart quotes, ligatures, trailing whitespace, etc.).
 *
 * NFKC is applied per base grapheme (a base code point plus any trailing
 * combining marks) so cross-code-point composition \u2014 e.g. "e"+U+0301 \u2192 "\u00E9" \u2014
 * is preserved while each output char still has a defined origin offset.
 * `normalizeForFuzzyMatch` is derived from this so the two never diverge.
 */
export function normalizeForFuzzyMatchWithMap(text: string): { normalized: string; map: number[] } {
	// Pass 1 \u2014 NFKC per base grapheme; nfkc[k] originated at nfkcOrigin[k].
	let nfkc = "";
	const nfkcOrigin: number[] = [];
	let i = 0;
	while (i < text.length) {
		const cp = text.codePointAt(i) as number;
		let groupEnd = i + (cp > 0xffff ? 2 : 1);
		while (groupEnd < text.length) {
			const next = text.codePointAt(groupEnd) as number;
			if (!COMBINING_MARK_RE.test(String.fromCodePoint(next))) break;
			groupEnd += next > 0xffff ? 2 : 1;
		}
		const norm = text.slice(i, groupEnd).normalize("NFKC");
		for (let k = 0; k < norm.length; k++) {
			nfkc += norm[k];
			nfkcOrigin.push(i);
		}
		i = groupEnd;
	}

	// Pass 2 \u2014 strip trailing horizontal whitespace (runs of [ \t\v\f] before a
	// newline or end of text), then fold. Order matches normalizeForFuzzyMatch:
	// strip first, fold second.
	let normalized = "";
	const map: number[] = [];
	let j = 0;
	while (j < nfkc.length) {
		if (isHorizontalWs(nfkc[j])) {
			let k = j;
			while (k < nfkc.length && isHorizontalWs(nfkc[k])) k++;
			if (k === nfkc.length || nfkc[k] === "\n") {
				j = k; // trailing run \u2192 drop
				continue;
			}
			normalized += nfkc[j];
			map.push(nfkcOrigin[j]);
			j++;
			continue;
		}
		normalized += foldFuzzyChar(nfkc[j]);
		map.push(nfkcOrigin[j]);
		j++;
	}
	map.push(text.length);
	return { normalized, map };
}

export function normalizeForFuzzyMatch(text: string): string {
	return normalizeForFuzzyMatchWithMap(text).normalized;
}

/**
 * Result of an indent-tolerant match. The match is anchored in the ORIGINAL
 * (un-stripped) content so we never lose indentation on surrounding lines.
 * `fromIndent`/`toIndent` describe the indentation delta the caller must apply
 * to the model's newText via `reindentText` to keep indentation consistent
 * with the surrounding block.
 */
export interface IndentMatchResult {
	index: number;
	matchLength: number;
	fromIndent: string;
	toIndent: string;
}

export interface Edit {
	oldText: string;
	newText: string;
	/**
	 * Replace every occurrence of `oldText` instead of requiring it to be unique.
	 * When false/absent, more than one match is a duplicate error (the default —
	 * forces the model to disambiguate). Use for renames where the same identifier
	 * appears many times intentionally.
	 */
	replaceAll?: boolean;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

export interface AppliedEditsResult {
	baseContent: string;
	newContent: string;
}

/** Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it */
export function stripBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

// --- Indent-tolerant matching --------------------------------------------------
//
// When exact and unicode-fuzzy match both fail, LLM mistakes almost always
// boil down to indentation drift: the oldText copy-pasted from `read` output
// (which may have line-number prefixes stripped imperfectly) is correct except
// for leading whitespace per line. We try to match by stripping leading
// whitespace from each line and walking the file by line windows. The match
// is anchored to original-content offsets, so unrelated lines keep their
// original indentation. The newText is re-indented by the same delta that
// turned oldText's first non-blank line into the matched first non-blank line.

/** Return leading-whitespace prefix of a line (tabs+spaces only). */
function leadingWhitespace(line: string): string {
	const match = /^[\t ]*/.exec(line);
	return match ? match[0] : "";
}

/** Index of the first line in lines[] whose trimStart() is non-empty. -1 if none. */
function firstNonBlankLine(lines: string[]): number {
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].trimStart() !== "") return i;
	}
	return -1;
}

/**
 * Re-indent every line of `text` by replacing the indentation delta computed
 * from `fromIndent -> toIndent` on the first non-blank line. Lines that are
 * fully blank are preserved as-is. Lines that share the `fromIndent` prefix get
 * the delta applied; lines with shorter indentation are left untouched.
 */
export function reindentText(text: string, fromIndent: string, toIndent: string): string {
	if (fromIndent === toIndent) return text;
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line.trimStart() === "") continue;
		if (line.startsWith(fromIndent)) {
			lines[i] = toIndent + line.slice(fromIndent.length);
			continue;
		}
		// fromIndent is empty but line has indent, or vice versa: prepend/strip toIndent.
		if (fromIndent === "") {
			lines[i] = toIndent + line;
		}
	}
	return lines.join("\n");
}

/**
 * Try to locate `oldText` inside `content` while ignoring leading whitespace
 * differences per line. Returns null when no unique match exists or when the
 * texts disagree on anything other than leading whitespace.
 *
 * The fromIndent/toIndent pair returned is the FIRST non-blank line in the
 * matched window where the two indentations actually disagree. That's the
 * transform the caller applies to the model's newText so it gets re-indented
 * in line with the surrounding block. If indentation already agrees on every
 * non-blank line we fall back to ("", "") (no rewrite).
 *
 * Complexity is O(L_content * L_oldText) in the worst case but bounded by
 * the size of the oldText line set.
 */
export function indentTolerantFind(content: string, oldText: string): IndentMatchResult | null {
	const contentLines = content.split("\n");
	const oldLines = oldText.split("\n");

	const oldAnchor = firstNonBlankLine(oldLines);
	if (oldAnchor === -1) return null;
	const oldAnchorTrimmed = oldLines[oldAnchor].trimStart();

	let match: { startLine: number; endLine: number; fromIndent: string; toIndent: string } | null = null;

	for (let start = 0; start + oldLines.length <= contentLines.length; start++) {
		const anchorLine = contentLines[start + oldAnchor];
		if (anchorLine.trimStart() !== oldAnchorTrimmed) continue;

		let ok = true;
		let fromIndent = "";
		let toIndent = "";
		let transformFound = false;
		for (let j = 0; j < oldLines.length; j++) {
			const candidate = contentLines[start + j];
			const expected = oldLines[j];
			if (expected.trimStart() === "") {
				if (candidate.trimStart() !== "") {
					ok = false;
					break;
				}
				continue;
			}
			if (candidate.trimStart() !== expected.trimStart()) {
				ok = false;
				break;
			}
			if (!transformFound) {
				const expectedIndent = leadingWhitespace(expected);
				const candidateIndent = leadingWhitespace(candidate);
				if (expectedIndent !== candidateIndent) {
					fromIndent = expectedIndent;
					toIndent = candidateIndent;
					transformFound = true;
				}
			}
		}
		if (!ok) continue;
		if (!transformFound) {
			// Indents agree on every non-blank line. An exact match should already
			// have handled this case, so skip and let other tiers report.
			continue;
		}

		if (match !== null) {
			// Ambiguous — bail out so the caller falls through to the duplicate error
			// path with full context, instead of guessing.
			return null;
		}
		match = {
			startLine: start,
			endLine: start + oldLines.length - 1,
			fromIndent,
			toIndent,
		};
	}

	if (!match) return null;

	// Compute byte offsets in original content for the matched line window.
	let index = 0;
	for (let i = 0; i < match.startLine; i++) {
		index += contentLines[i].length + 1; // +1 for the trailing \n
	}
	let matchLength = 0;
	for (let i = match.startLine; i <= match.endLine; i++) {
		matchLength += contentLines[i].length;
		if (i < match.endLine) matchLength += 1; // inter-line \n
	}

	return {
		index,
		matchLength,
		fromIndent: match.fromIndent,
		toIndent: match.toIndent,
	};
}

// --- Near-miss diagnostics ----------------------------------------------------
//
// When a match cannot be found, we want the error to point the model at the
// nearest plausible location so the retry does not blindly resend the same
// oldText. We score candidate windows by anchor-line match count and report
// the first divergent line.

const NEAR_MISS_MAX_BODY_CHARS = 200;
const NEAR_MISS_MAX_CANDIDATE_WINDOWS = 4000;

function truncateForDiagnostic(text: string): string {
	const single = text.replace(/\n/g, "\\n");
	if (single.length <= NEAR_MISS_MAX_BODY_CHARS) return single;
	return `${sliceSafe(single, 0, NEAR_MISS_MAX_BODY_CHARS)}…`;
}

/**
 * Best-effort "did you mean line N?" hint for the not-found error path. Walks
 * the file looking for the line-window with the highest count of matching
 * trimmed lines against oldText; if any meaningful overlap exists, reports the
 * first divergence so the model can fix its oldText surgically.
 *
 * Returns null when no candidate has any matching lines.
 */
export function buildNearMissHint(content: string, oldText: string): string | null {
	const candidates = buildCandidateMatches(content, oldText, { maxCandidates: 1 });
	if (candidates.length === 0) return null;
	const top = candidates[0];
	return `Closest candidate starts at line ${top.startLine} (${top.score}/${top.windowSize} lines match). First divergence at line ${top.divergenceLine}:\n  expected: ${top.expectedSnippet}\n  found:    ${top.foundSnippet}`;
}

export interface CandidateMatch {
	/** 1-indexed start line of the candidate window in the file. */
	startLine: number;
	/** 1-indexed end line of the candidate window (inclusive). */
	endLine: number;
	/** Number of `oldText` lines whose trimStart() matches the corresponding window line. */
	score: number;
	/** Window length in lines (== oldText line count). */
	windowSize: number;
	/** 1-indexed line where window first diverges from oldText. */
	divergenceLine: number;
	/** Truncated display of `oldText[divergenceLine - startLine]`. */
	expectedSnippet: string;
	/** Truncated display of the file's line at `divergenceLine`. */
	foundSnippet: string;
	/** Verbatim slice of the file covering the window, suitable as a copy-pasteable `oldText`. */
	verbatimSnippet: string;
}

/**
 * Top-K ranked candidate windows for a failed exact-match `edit` call. Each
 * candidate carries the verbatim snippet the model can paste back as
 * `oldText` to get an exact match on the next try — turning a "guess what
 * went wrong" recovery into a copy-paste.
 */
export function buildCandidateMatches(
	content: string,
	oldText: string,
	options?: { maxCandidates?: number; minScore?: number },
): CandidateMatch[] {
	const maxCandidates = Math.max(1, options?.maxCandidates ?? 3);
	const minScore = Math.max(1, options?.minScore ?? 2);

	const contentLines = content.split("\n");
	const oldLines = oldText.split("\n");
	if (oldLines.length === 0 || contentLines.length === 0) return [];

	const windowSize = oldLines.length;
	const maxStart = Math.min(contentLines.length - windowSize + 1, NEAR_MISS_MAX_CANDIDATE_WINDOWS);
	if (maxStart <= 0) return [];

	// Precompute leading-trimmed lines once. The Pass-1 scan compares every
	// window position against `oldText`, so without caching each `trimStart()`
	// would be recomputed up to `maxStart` times per line — tens of millions of
	// allocations for a large failed edit. Cache is behavior-identical.
	const oldTrim = oldLines.map((line) => line.trimStart());
	const contentTrim = contentLines.map((line) => line.trimStart());

	const nonBlankOldLines = oldTrim.reduce((count, line) => (line !== "" ? count + 1 : count), 0);

	// Pass 1 — score every window position. Cheap O(n × windowSize) scan.
	type ScoredWindow = { start: number; score: number };
	const scored: ScoredWindow[] = [];
	for (let start = 0; start < maxStart; start++) {
		let score = 0;
		for (let j = 0; j < windowSize; j++) {
			const expected = oldTrim[j];
			// Only count non-blank line agreements so blank-line pile-up doesn't
			// fabricate near-miss hints out of unrelated files.
			if (expected !== "" && contentTrim[start + j] === expected) {
				score++;
			}
		}
		if (score >= minScore && score < nonBlankOldLines) {
			scored.push({ start, score });
		}
	}
	if (scored.length === 0) return [];

	// Pass 2 — pick top-K by score, then by earliest position to break ties.
	scored.sort((a, b) => b.score - a.score || a.start - b.start);

	const selected: ScoredWindow[] = [];
	const seenStarts = new Set<number>();
	const halfWindow = Math.max(2, Math.floor(windowSize / 2));
	for (const candidate of scored) {
		// Suppress overlapping windows that share a start vicinity — they
		// usually describe the same divergence twice.
		let nearby = false;
		for (const s of seenStarts) {
			if (Math.abs(s - candidate.start) < halfWindow) {
				nearby = true;
				break;
			}
		}
		if (nearby) continue;
		selected.push(candidate);
		seenStarts.add(candidate.start);
		if (selected.length >= maxCandidates) break;
	}

	return selected.map((candidate) => {
		let divergenceOffset = 0;
		for (let j = 0; j < windowSize; j++) {
			if (contentTrim[candidate.start + j] !== oldTrim[j]) {
				divergenceOffset = j;
				break;
			}
		}
		const divergenceLine = candidate.start + divergenceOffset + 1;
		const verbatimSnippet = contentLines.slice(candidate.start, candidate.start + windowSize).join("\n");
		return {
			startLine: candidate.start + 1,
			endLine: candidate.start + windowSize,
			score: candidate.score,
			windowSize,
			divergenceLine,
			expectedSnippet: truncateForDiagnostic(oldLines[divergenceOffset]),
			foundSnippet: truncateForDiagnostic(contentLines[candidate.start + divergenceOffset]),
			verbatimSnippet,
		};
	});
}

/** Format the top-K candidates as a copy-pasteable error suffix. */
export function formatCandidateMatchesForError(candidates: CandidateMatch[]): string | null {
	if (candidates.length === 0) return null;
	const parts: string[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const c = candidates[i];
		const header = `Candidate ${i + 1}: lines ${c.startLine}-${c.endLine} (${c.score}/${c.windowSize} lines match, first divergence at line ${c.divergenceLine}):`;
		const diff = `  expected: ${c.expectedSnippet}\n  found:    ${c.foundSnippet}`;
		const block = `  Paste this verbatim as oldText for an exact match:\n  ─────\n${indentBlock(c.verbatimSnippet, "  ")}\n  ─────`;
		parts.push(`${header}\n${diff}\n${block}`);
	}
	return parts.join("\n\n");
}

function indentBlock(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function countSubstring(haystack: string, needle: string): number {
	if (needle.length === 0) return 0;
	let count = 0;
	let from = 0;
	for (;;) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) break;
		count++;
		from = idx + needle.length;
	}
	return count;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number, hint?: string | null): Error {
	const suffix = hint ? `\n${hint}` : "";
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.${suffix}`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.${suffix}`,
	);
}

/** 1-based line numbers of the first `limit` non-overlapping occurrences of `needle`. */
function findOccurrenceLines(content: string, needle: string, limit: number): number[] {
	const out: number[] = [];
	let from = content.indexOf(needle);
	while (from !== -1 && out.length < limit) {
		out.push(content.slice(0, from).split("\n").length);
		from = content.indexOf(needle, from + needle.length);
	}
	return out;
}

function getDuplicateError(
	path: string,
	editIndex: number,
	totalEdits: number,
	occurrences: number,
	occurrenceLines?: number[],
): Error {
	// Unlike the not-found path, a duplicate gave the model no clue WHERE the
	// matches are, so it would retry with a still-ambiguous oldText. Naming the
	// lines lets it add a unique surrounding line in one shot.
	const locationHint =
		occurrenceLines && occurrenceLines.length > 0
			? ` Occurrences at line(s): ${occurrenceLines.join(", ")}${occurrenceLines.length < occurrences ? ", …" : ""}. Add a unique surrounding line to disambiguate.`
			: " Please provide more context to make it unique.";
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique.${locationHint}`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique.${locationHint}`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(`oldText must not be empty in ${path}.`);
	}
	return new Error(`edits[${editIndex}].oldText must not be empty in ${path}.`);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/**
 * Apply one or more text replacements to LF-normalized content.
 *
 * Every edit is matched and spliced against the ORIGINAL content. Exact matches
 * use it directly; fuzzy matches (smart quotes, NFKC, trailing whitespace,
 * Unicode dashes/spaces) are located in normalized space and projected back to
 * original offsets via {@link normalizeForFuzzyMatchWithMap}, so only the
 * matched window changes — regions outside every edit keep their exact original
 * bytes. Replacements are applied in reverse order so offsets stay stable. The
 * returned baseContent is always the original content, so the caller's diff
 * reflects the real on-disk delta instead of a file-wide re-normalization.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
		replaceAll: edit.replaceAll === true,
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	// Fuzzy projection of the original content, built lazily and reused across
	// edits — only when an edit actually needs fuzzy matching.
	let fuzzy: { normalized: string; map: number[] } | undefined;
	const getFuzzy = (): { normalized: string; map: number[] } => {
		if (!fuzzy) fuzzy = normalizeForFuzzyMatchWithMap(normalizedContent);
		return fuzzy;
	};

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];

		// Tier 1 — exact match against the original content.
		const exactCount = countSubstring(normalizedContent, edit.oldText);
		if (exactCount > 1) {
			if (!edit.replaceAll) {
				const lines = findOccurrenceLines(normalizedContent, edit.oldText, 5);
				throw getDuplicateError(path, i, normalizedEdits.length, exactCount, lines);
			}
			// replaceAll: stage every non-overlapping occurrence. They cannot overlap
			// each other (scan advances past each match), and the reverse-order splice
			// below keeps offsets stable.
			let from = normalizedContent.indexOf(edit.oldText);
			while (from !== -1) {
				matchedEdits.push({
					editIndex: i,
					matchIndex: from,
					matchLength: edit.oldText.length,
					newText: edit.newText,
				});
				from = normalizedContent.indexOf(edit.oldText, from + edit.oldText.length);
			}
			continue;
		}
		if (exactCount === 1) {
			matchedEdits.push({
				editIndex: i,
				matchIndex: normalizedContent.indexOf(edit.oldText),
				matchLength: edit.oldText.length,
				newText: edit.newText,
			});
			continue;
		}

		// Tier 2 — fuzzy match in normalized space, projected back to original
		// offsets so the splice preserves everything outside the matched window.
		const { normalized, map } = getFuzzy();
		const fuzzyOldText = normalizeForFuzzyMatch(edit.oldText);
		const fuzzyIndex = normalized.indexOf(fuzzyOldText);
		if (fuzzyIndex !== -1) {
			const occurrences = countSubstring(normalized, fuzzyOldText);
			if (occurrences > 1) {
				if (!edit.replaceAll) {
					throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
				}
				let from = fuzzyIndex;
				while (from !== -1) {
					const matchIndex = map[from];
					const matchLength = map[from + fuzzyOldText.length] - matchIndex;
					matchedEdits.push({ editIndex: i, matchIndex, matchLength, newText: edit.newText });
					from = normalized.indexOf(fuzzyOldText, from + fuzzyOldText.length);
				}
				continue;
			}
			const matchIndex = map[fuzzyIndex];
			const matchLength = map[fuzzyIndex + fuzzyOldText.length] - matchIndex;
			matchedEdits.push({ editIndex: i, matchIndex, matchLength, newText: edit.newText });
			continue;
		}

		// Tier 3 — indent-tolerant, anchored in the original content. Re-indent
		// the newText to match the surrounding block.
		const indentMatch = indentTolerantFind(normalizedContent, edit.oldText);
		if (indentMatch) {
			matchedEdits.push({
				editIndex: i,
				matchIndex: indentMatch.index,
				matchLength: indentMatch.matchLength,
				newText: reindentText(edit.newText, indentMatch.fromIndent, indentMatch.toIndent),
			});
			continue;
		}

		const candidates = buildCandidateMatches(normalizedContent, edit.oldText, { maxCandidates: 2 });
		const hint = formatCandidateMatchesForError(candidates);
		throw getNotFoundError(path, i, normalizedEdits.length, hint);
	}

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let newContent = normalizedContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (normalizedContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent: normalizedContent, newContent };
}

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];

	const oldLines = oldContent.split("\n");
	const newLines = newContent.split("\n");
	const maxLineNum = Math.max(oldLines.length, newLines.length);
	const lineNumWidth = String(maxLineNum).length;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					const lineNum = String(newLineNum).padStart(lineNumWidth, " ");
					output.push(`+${lineNum} ${line}`);
					newLineNum++;
				} else {
					// removed
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(`-${lineNum} ${line}`);
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
			const hasLeadingChange = lastWasChange;
			const hasTrailingChange = nextPartIsChange;

			if (hasLeadingChange && hasTrailingChange) {
				if (raw.length <= contextLines * 2) {
					for (const line of raw) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				} else {
					const leadingLines = raw.slice(0, contextLines);
					const trailingLines = raw.slice(raw.length - contextLines);
					const skippedLines = raw.length - leadingLines.length - trailingLines.length;

					for (const line of leadingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}

					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;

					for (const line of trailingLines) {
						const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
						output.push(` ${lineNum} ${line}`);
						oldLineNum++;
						newLineNum++;
					}
				}
			} else if (hasLeadingChange) {
				const shownLines = raw.slice(0, contextLines);
				const skippedLines = raw.length - shownLines.length;

				for (const line of shownLines) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}

				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}
			} else if (hasTrailingChange) {
				const skippedLines = Math.max(0, raw.length - contextLines);
				if (skippedLines > 0) {
					output.push(` ${"".padStart(lineNumWidth, " ")} ...`);
					oldLineNum += skippedLines;
					newLineNum += skippedLines;
				}

				for (const line of raw.slice(skippedLines)) {
					const lineNum = String(oldLineNum).padStart(lineNumWidth, " ");
					output.push(` ${lineNum} ${line}`);
					oldLineNum++;
					newLineNum++;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	return { diff: output.join("\n"), firstChangedLine };
}

export interface EditDiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface EditDiffError {
	error: string;
}

/**
 * Match `edits` against already-normalized (BOM-stripped, LF) base content and
 * render the diff. Shared by {@link computeEditsDiff} and
 * {@link computeEditsDiffWithBaseCache} so both produce byte-identical output;
 * only the way `normalizedContent` is obtained (fresh read vs. cache) differs.
 */
function diffFromNormalizedBase(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): EditDiffResult | EditDiffError {
	try {
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
 *
 * Always re-reads from disk — callers that re-run this for the SAME file while
 * args stream (the edit renderCall) should use {@link computeEditsDiffWithBaseCache}
 * instead to skip redundant whole-file reads.
 */
export async function computeEditsDiff(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		// Read the file
		const rawContent = await readFile(absolutePath, "utf-8");

		// Strip BOM before matching (LLM won't include invisible BOM in oldText)
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		return diffFromNormalizedBase(normalizedContent, edits, path);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

// --- Cached base read for streaming preview -----------------------------------
//
// During an `edit` tool-call the renderCall re-dispatches computeEditsDiff on
// every newText/oldText delta (each delta changes argsKey). The base FILE
// content is invariant across those dispatches, so re-reading + re-normalizing
// the whole file K times per edit is pure waste on a 1500–3000 line file.
//
// We cache the normalized (BOM-stripped, LF) base content keyed by
// (absolutePath, mtimeMs). The cache stores the SAME string that the non-cached
// path feeds to applyEditsToNormalizedContent, so the diff is byte-identical.
// Invalidation is by mtimeMs: stat() is cheap and a changed mtime means the
// file was edited externally mid-stream, so we re-read. The cache is a tiny LRU
// (2 entries) — it never retains large file bodies indefinitely.

interface BaseCacheEntry {
	key: string;
	normalizedContent: string;
}

const BASE_CACHE_MAX_ENTRIES = 2;
const baseCache: BaseCacheEntry[] = [];

// Test seam: counts actual whole-file reads done by the cached path so a test
// can prove a cache hit skipped disk. Not part of the public contract.
let baseCacheDiskReads = 0;

export function __getEditDiffBaseCacheDiskReads(): number {
	return baseCacheDiskReads;
}

export function __resetEditDiffBaseCache(): void {
	baseCache.length = 0;
	baseCacheDiskReads = 0;
}

function getCachedBase(key: string): string | undefined {
	const idx = baseCache.findIndex((entry) => entry.key === key);
	if (idx === -1) return undefined;
	// Move to most-recently-used position.
	const [entry] = baseCache.splice(idx, 1);
	baseCache.push(entry);
	return entry.normalizedContent;
}

function putCachedBase(key: string, normalizedContent: string): void {
	const existing = baseCache.findIndex((entry) => entry.key === key);
	if (existing !== -1) baseCache.splice(existing, 1);
	baseCache.push({ key, normalizedContent });
	while (baseCache.length > BASE_CACHE_MAX_ENTRIES) baseCache.shift();
}

/**
 * Like {@link computeEditsDiff}, but caches the normalized base content by
 * (absolutePath, mtimeMs) and reuses it across repeated calls for the same
 * unchanged file — the streaming-preview hot path. Result is byte-identical to
 * {@link computeEditsDiff}; only redundant whole-file reads are elided.
 */
export async function computeEditsDiffWithBaseCache(
	path: string,
	edits: Edit[],
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	const absolutePath = resolveToCwd(path, cwd);

	try {
		// Check if file exists and is readable
		try {
			await access(absolutePath, constants.R_OK);
		} catch (error: unknown) {
			const errorMessage = error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
			return { error: `Could not edit file: ${path}. ${errorMessage}.` };
		}

		let normalizedContent: string | undefined;
		try {
			const stats = await stat(absolutePath);
			const key = `${absolutePath} ${stats.mtimeMs}`;
			normalizedContent = getCachedBase(key);
			if (normalizedContent === undefined) {
				const rawContent = await readFile(absolutePath, "utf-8");
				baseCacheDiskReads++;
				const { text: content } = stripBom(rawContent);
				normalizedContent = normalizeToLF(content);
				putCachedBase(key, normalizedContent);
			}
		} catch {
			// stat/read failed after the access check (race, transient FS error):
			// fall back to a plain uncached read so behavior matches computeEditsDiff.
			const rawContent = await readFile(absolutePath, "utf-8");
			const { text: content } = stripBom(rawContent);
			normalizedContent = normalizeToLF(content);
		}

		return diffFromNormalizedBase(normalizedContent, edits, path);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
