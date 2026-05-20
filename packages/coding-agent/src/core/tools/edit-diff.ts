/**
 * Shared diff computation utilities for the edit tool.
 * Used by both edit.ts (for execution) and tool-execution.ts (for preview rendering).
 */

import * as Diff from "diff";
import { constants } from "fs";
import { access, readFile } from "fs/promises";
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
export function normalizeForFuzzyMatch(text: string): string {
	return (
		text
			.normalize("NFKC")
			// Strip trailing whitespace per line
			.split("\n")
			.map((line) => line.trimEnd())
			.join("\n")
			// Smart single quotes → '
			.replace(/[\u2018\u2019\u201A\u201B]/g, "'")
			// Smart double quotes → "
			.replace(/[\u201C\u201D\u201E\u201F]/g, '"')
			// Various dashes/hyphens → -
			// U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
			// U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
			.replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
			// Special spaces → regular space
			// U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
			// U+205F medium math space, U+3000 ideographic space
			.replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
	);
}

export interface FuzzyMatchResult {
	/** Whether a match was found */
	found: boolean;
	/** The index where the match starts (in the content that should be used for replacement) */
	index: number;
	/** Length of the matched text */
	matchLength: number;
	/** Whether fuzzy matching was used (false = exact match) */
	usedFuzzyMatch: boolean;
	/**
	 * The content to use for replacement operations.
	 * When exact match: original content. When fuzzy match: normalized content.
	 */
	contentForReplacement: string;
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

/**
 * Find oldText in content, trying exact match first, then fuzzy match.
 * When fuzzy matching is used, the returned contentForReplacement is the
 * fuzzy-normalized version of the content (trailing whitespace stripped,
 * Unicode quotes/dashes normalized to ASCII).
 */
export function fuzzyFindText(content: string, oldText: string): FuzzyMatchResult {
	// Try exact match first
	const exactIndex = content.indexOf(oldText);
	if (exactIndex !== -1) {
		return {
			found: true,
			index: exactIndex,
			matchLength: oldText.length,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// Try fuzzy match - work entirely in normalized space
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

	if (fuzzyIndex === -1) {
		return {
			found: false,
			index: -1,
			matchLength: 0,
			usedFuzzyMatch: false,
			contentForReplacement: content,
		};
	}

	// When fuzzy matching, we work in the normalized space for replacement.
	// This means the output will have normalized whitespace/quotes/dashes,
	// which is acceptable since we're fixing minor formatting differences anyway.
	return {
		found: true,
		index: fuzzyIndex,
		matchLength: fuzzyOldText.length,
		usedFuzzyMatch: true,
		contentForReplacement: fuzzyContent,
	};
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
	return `${single.slice(0, NEAR_MISS_MAX_BODY_CHARS)}…`;
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
	const contentLines = content.split("\n");
	const oldLines = oldText.split("\n");
	if (oldLines.length === 0 || contentLines.length === 0) return null;

	const windowSize = oldLines.length;
	const maxStart = Math.min(contentLines.length - windowSize + 1, NEAR_MISS_MAX_CANDIDATE_WINDOWS);
	if (maxStart <= 0) return null;

	let bestStart = -1;
	let bestScore = 0;
	for (let start = 0; start < maxStart; start++) {
		let score = 0;
		for (let j = 0; j < windowSize; j++) {
			const expected = oldLines[j].trimStart();
			// Only count non-blank line agreements so blank-line pile-up doesn't
			// fabricate near-miss hints out of unrelated files.
			if (expected !== "" && contentLines[start + j].trimStart() === expected) {
				score++;
			}
		}
		if (score > bestScore) {
			bestScore = score;
			bestStart = start;
			if (score === windowSize) break; // can't beat a perfect line-trim match
		}
	}

	const nonBlankOldLines = oldLines.filter((line) => line.trimStart() !== "").length;
	// Need at least 2 non-blank lines matching (single-line coincidence is
	// usually noise) and at least one divergence; otherwise drop the hint.
	if (bestStart === -1 || bestScore < 2 || bestScore === nonBlankOldLines) return null;

	let divergenceOffset = -1;
	for (let j = 0; j < windowSize; j++) {
		if (contentLines[bestStart + j].trimStart() !== oldLines[j].trimStart()) {
			divergenceOffset = j;
			break;
		}
	}
	if (divergenceOffset === -1) return null;

	const lineNumber = bestStart + divergenceOffset + 1; // 1-indexed for humans
	const expected = truncateForDiagnostic(oldLines[divergenceOffset]);
	const found = truncateForDiagnostic(contentLines[bestStart + divergenceOffset]);
	return `Closest candidate starts at line ${bestStart + 1} (${bestScore}/${windowSize} lines match). First divergence at line ${lineNumber}:\n  expected: ${expected}\n  found:    ${found}`;
}

function countOccurrences(content: string, oldText: string): number {
	const fuzzyContent = normalizeForFuzzyMatch(content);
	const fuzzyOldText = normalizeForFuzzyMatch(oldText);
	return fuzzyContent.split(fuzzyOldText).length - 1;
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

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
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
 * Apply one or more exact-text replacements to LF-normalized content.
 *
 * All edits are matched against the same original content. Replacements are
 * then applied in reverse order so offsets remain stable. If any edit needs
 * fuzzy matching, the operation runs in fuzzy-normalized content space to
 * preserve current single-edit behavior.
 */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): AppliedEditsResult {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));

	for (let i = 0; i < normalizedEdits.length; i++) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw getEmptyOldTextError(path, i, normalizedEdits.length);
		}
	}

	const initialMatches = normalizedEdits.map((edit) => fuzzyFindText(normalizedContent, edit.oldText));
	const baseContent = initialMatches.some((match) => match.usedFuzzyMatch)
		? normalizeForFuzzyMatch(normalizedContent)
		: normalizedContent;

	const matchedEdits: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i++) {
		const edit = normalizedEdits[i];
		const matchResult = fuzzyFindText(baseContent, edit.oldText);
		if (!matchResult.found) {
			// Tier-3: indent-tolerant. Anchored in baseContent so multi-edit offsets
			// stay consistent. Re-indent the newText to match the surrounding block.
			const indentMatch = indentTolerantFind(baseContent, edit.oldText);
			if (indentMatch) {
				matchedEdits.push({
					editIndex: i,
					matchIndex: indentMatch.index,
					matchLength: indentMatch.matchLength,
					newText: reindentText(edit.newText, indentMatch.fromIndent, indentMatch.toIndent),
				});
				continue;
			}
			const hint = buildNearMissHint(baseContent, edit.oldText);
			throw getNotFoundError(path, i, normalizedEdits.length, hint);
		}

		const occurrences = countOccurrences(baseContent, edit.oldText);
		if (occurrences > 1) {
			throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		}

		matchedEdits.push({
			editIndex: i,
			matchIndex: matchResult.index,
			matchLength: matchResult.matchLength,
			newText: edit.newText,
		});
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

	let newContent = baseContent;
	for (let i = matchedEdits.length - 1; i >= 0; i--) {
		const edit = matchedEdits[i];
		newContent =
			newContent.substring(0, edit.matchIndex) +
			edit.newText +
			newContent.substring(edit.matchIndex + edit.matchLength);
	}

	if (baseContent === newContent) {
		throw getNoChangeError(path, normalizedEdits.length);
	}

	return { baseContent, newContent };
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
 * Compute the diff for one or more edit operations without applying them.
 * Used for preview rendering in the TUI before the tool executes.
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
		const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);

		// Generate the diff
		return generateDiffString(baseContent, newContent);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * Compute the diff for a single edit operation without applying it.
 * Kept as a convenience wrapper for single-edit callers.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
): Promise<EditDiffResult | EditDiffError> {
	return computeEditsDiff(path, [{ oldText, newText }], cwd);
}
