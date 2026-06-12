import { isPunctuationChar, isWhitespaceChar } from "./utils.ts";

/**
 * Pure text-editing primitives shared by the single-line {@link Input} and the
 * multi-line {@link Editor}. These were previously duplicated verbatim between
 * the two components; they live here so both consume one implementation.
 *
 * Everything in this module is pure: it operates on the supplied text/graphemes
 * and returns new values. Stateful concerns (kill ring, undo, multi-line merge,
 * autocomplete, change notifications) stay in the components.
 */

/** Minimal grapheme shape — structurally compatible with `Intl.SegmentData`. */
export interface GraphemeSegment {
	segment: string;
}

/** Direction for word-wise cursor movement / deletion. */
export type WordMoveDirection = "backward" | "forward";

/**
 * Predicate identifying a segment that should be treated as a single atomic
 * word (used by the Editor for `[paste #N …]` markers). The default treats no
 * segment as a marker, which reduces the logic to plain word movement.
 */
export type PasteMarkerPredicate = (segment: string) => boolean;

const NO_PASTE_MARKER: PasteMarkerPredicate = () => false;

/**
 * Some terminals (e.g. tmux popups with extended-keys-format=csi-u) re-encode
 * control bytes inside bracketed paste as CSI-u Ctrl+<letter> sequences
 * (ESC [ <codepoint> ; 5 u). Decode those back to their literal control byte so
 * the per-char cleanup in the caller preserves/strips them correctly instead of
 * leaking the printable tail (e.g. "[106;5u") into the buffer.
 *
 * Consumed verbatim by both `Input.handlePaste` and `Editor.handlePaste`.
 */
export function decodeBracketedPasteCsiU(pastedText: string): string {
	return pastedText.replace(/\x1b\[(\d+);5u/g, (match, code) => {
		const cp = Number(code);
		if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
		if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
		return match;
	});
}

/**
 * Compute the column a word-wise cursor move lands on (Emacs-style: skip a
 * leading whitespace run, then a single punctuation run OR a single word run).
 *
 * For `"backward"`, pass the graphemes of the text BEFORE the cursor; the
 * result is `startCol` minus the width of the skipped run.
 * For `"forward"`, pass the graphemes of the text AFTER the cursor; the result
 * is `startCol` plus the width of the skipped run.
 *
 * `isPasteMarker` lets the caller treat a marker segment as a single atomic
 * word; the default predicate yields plain word movement.
 */
export function computeWordMoveColumn(
	graphemes: readonly GraphemeSegment[],
	startCol: number,
	direction: WordMoveDirection,
	isPasteMarker: PasteMarkerPredicate = NO_PASTE_MARKER,
): number {
	const segAt = (k: number): string => graphemes[k]?.segment || "";
	const lenAt = (k: number): number => graphemes[k]?.segment.length || 0;
	let col = startCol;

	if (direction === "backward") {
		// Consume from the end of the before-cursor graphemes.
		let i = graphemes.length - 1;

		// Skip trailing whitespace.
		while (i >= 0 && !isPasteMarker(segAt(i)) && isWhitespaceChar(segAt(i))) {
			col -= lenAt(i);
			i--;
		}

		if (i >= 0) {
			const lastGrapheme = segAt(i);
			if (isPasteMarker(lastGrapheme)) {
				// Paste marker is a single atomic word.
				col -= lenAt(i);
			} else if (isPunctuationChar(lastGrapheme)) {
				// Skip punctuation run.
				while (i >= 0 && isPunctuationChar(segAt(i)) && !isPasteMarker(segAt(i))) {
					col -= lenAt(i);
					i--;
				}
			} else {
				// Skip word run.
				while (i >= 0 && !isWhitespaceChar(segAt(i)) && !isPunctuationChar(segAt(i)) && !isPasteMarker(segAt(i))) {
					col -= lenAt(i);
					i--;
				}
			}
		}

		return col;
	}

	// Forward: consume from the start of the after-cursor graphemes.
	let j = 0;

	// Skip leading whitespace.
	while (j < graphemes.length && !isPasteMarker(segAt(j)) && isWhitespaceChar(segAt(j))) {
		col += lenAt(j);
		j++;
	}

	if (j < graphemes.length) {
		const firstGrapheme = segAt(j);
		if (isPasteMarker(firstGrapheme)) {
			// Paste marker is a single atomic word.
			col += firstGrapheme.length;
		} else if (isPunctuationChar(firstGrapheme)) {
			// Skip punctuation run.
			while (j < graphemes.length && isPunctuationChar(segAt(j)) && !isPasteMarker(segAt(j))) {
				col += lenAt(j);
				j++;
			}
		} else {
			// Skip word run.
			while (
				j < graphemes.length &&
				!isWhitespaceChar(segAt(j)) &&
				!isPunctuationChar(segAt(j)) &&
				!isPasteMarker(segAt(j))
			) {
				col += lenAt(j);
				j++;
			}
		}
	}

	return col;
}

/** Result of a word-wise deletion on a single line/value. */
export interface WordDeletionResult {
	/** The removed text — caller pushes this onto the kill ring. */
	deletedText: string;
	/** The line/value with the word removed. */
	newText: string;
	/** The cursor column after deletion. */
	newCol: number;
	/** Kill-ring placement: backward deletions prepend, forward deletions append. */
	prepend: boolean;
}

/**
 * Compute the result of a word-wise deletion (Ctrl+W / Alt+D) on a single line
 * of text. The boundary matches {@link computeWordMoveColumn}; this derives the
 * deleted slice, the resulting text, and the new cursor column.
 *
 * The caller supplies the `segment` function (so `Input` uses the base
 * segmenter and `Editor` uses its paste-marker-aware one). Kill-ring push, undo
 * snapshots, multi-line merges at the line edges, and change notifications all
 * remain the caller's responsibility — only the pure slice math is shared.
 */
export function computeWordDeletion(
	text: string,
	cursorCol: number,
	direction: WordMoveDirection,
	segment: (input: string) => Iterable<GraphemeSegment>,
	isPasteMarker: PasteMarkerPredicate = NO_PASTE_MARKER,
): WordDeletionResult {
	if (direction === "backward") {
		const graphemes = [...segment(text.slice(0, cursorCol))];
		const deleteFrom = computeWordMoveColumn(graphemes, cursorCol, "backward", isPasteMarker);
		return {
			deletedText: text.slice(deleteFrom, cursorCol),
			newText: text.slice(0, deleteFrom) + text.slice(cursorCol),
			newCol: deleteFrom,
			prepend: true,
		};
	}

	const graphemes = [...segment(text.slice(cursorCol))];
	const deleteTo = computeWordMoveColumn(graphemes, cursorCol, "forward", isPasteMarker);
	return {
		deletedText: text.slice(cursorCol, deleteTo),
		newText: text.slice(0, cursorCol) + text.slice(deleteTo),
		newCol: cursorCol,
		prepend: false,
	};
}
