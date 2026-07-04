import { performance } from "node:perf_hooks";
import type { AutocompleteProvider, AutocompleteSuggestions } from "../autocomplete.ts";
import { getKeybindings } from "../keybindings.ts";
import { decodePrintableKey, matchesKey } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { computeWordDeletion, computeWordMoveColumn, decodeBracketedPasteCsiU } from "../text-edit-core.ts";
import { type Component, CURSOR_MARKER, type Focusable, type TUI } from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import { extractAnsiCode, getSegmenter, isWhitespaceChar, truncateToWidth, visibleWidth } from "../utils.ts";
import { type SelectItem, SelectList, type SelectListLayoutOptions, type SelectListTheme } from "./select-list.ts";

const baseSegmenter = getSegmenter();

/** Shared empty paste-id set, returned when no pastes are active (never mutated). */
const EMPTY_PASTE_IDS: Set<number> = new Set<number>();

/** Regex matching paste markers like `[paste #1 +123 lines]` or `[paste #2 1234 chars]`. */
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;

/** Non-global version for single-segment testing. */
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;

/** Check if a segment is a paste marker (i.e. was merged by segmentWithMarkers). */
function isPasteMarker(segment: string): boolean {
	return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

/**
 * A segmenter that wraps Intl.Segmenter and merges graphemes that fall
 * within paste markers into single atomic segments.  This makes cursor
 * movement, deletion, word-wrap, etc. treat paste markers as single units.
 *
 * Only markers whose numeric ID exists in `validIds` are merged.
 */
function segmentWithMarkers(text: string, validIds: Set<number>): Iterable<Intl.SegmentData> {
	// Fast path: no paste markers in the text or no valid IDs.
	if (validIds.size === 0 || !text.includes("[paste #")) {
		return baseSegmenter.segment(text);
	}

	// Find all marker spans with valid IDs.
	const markers: Array<{ start: number; end: number }> = [];
	for (const m of text.matchAll(PASTE_MARKER_REGEX)) {
		const id = Number.parseInt(m[1]!, 10);
		if (!validIds.has(id)) continue;
		markers.push({ start: m.index, end: m.index + m[0].length });
	}
	if (markers.length === 0) {
		return baseSegmenter.segment(text);
	}

	// Build merged segment list.
	const baseSegments = baseSegmenter.segment(text);
	const result: Intl.SegmentData[] = [];
	let markerIdx = 0;

	for (const seg of baseSegments) {
		// Skip past markers that are entirely before this segment.
		while (markerIdx < markers.length && markers[markerIdx]!.end <= seg.index) {
			markerIdx++;
		}

		const marker = markerIdx < markers.length ? markers[markerIdx]! : null;

		if (marker && seg.index >= marker.start && seg.index < marker.end) {
			// This segment falls inside a marker.
			// If this is the first segment of the marker, emit a merged segment.
			if (seg.index === marker.start) {
				const markerText = text.slice(marker.start, marker.end);
				result.push({
					segment: markerText,
					index: marker.start,
					input: text,
				});
			}
			// Otherwise skip (already merged into the first segment).
		} else {
			result.push(seg);
		}
	}

	return result;
}

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
export interface TextChunk {
	text: string;
	startIndex: number;
	endIndex: number;
	/** Visible width of `text`, computed once at wrap time and cached with the chunk. */
	width: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @param preSegmented - Optional pre-segmented graphemes (e.g. with paste-marker awareness).
 *                       When omitted the default Intl.Segmenter is used.
 * @returns Array of chunks with text and position information
 */
export function wordWrapLine(line: string, maxWidth: number, preSegmented?: Intl.SegmentData[]): TextChunk[] {
	if (!line || maxWidth <= 0) {
		return [{ text: "", startIndex: 0, endIndex: 0, width: 0 }];
	}

	const lineWidth = visibleWidth(line);
	if (lineWidth <= maxWidth) {
		return [{ text: line, startIndex: 0, endIndex: line.length, width: lineWidth }];
	}

	const chunks: TextChunk[] = [];
	const segments = preSegmented ?? [...baseSegmenter.segment(line)];

	// Base case: a single indivisible grapheme can't be wrapped below its own
	// width. Emit it as one chunk and accept the overflow. Without this the
	// `gWidth > maxWidth` branch below would recurse with the identical
	// single-grapheme string and stack-overflow (e.g. a 2-wide CJK/emoji in a
	// 1-column terminal).
	if (segments.length === 1 && isPasteMarker(line)) {
		return wordWrapLine(line, maxWidth, [...baseSegmenter.segment(line)]);
	}

	if (segments.length === 1) {
		return [{ text: line, startIndex: 0, endIndex: line.length, width: lineWidth }];
	}

	let currentWidth = 0;
	let chunkStart = 0;

	// Wrap opportunity: the position after the last whitespace before a non-whitespace
	// grapheme, i.e. where a line break is allowed.
	let wrapOppIndex = -1;
	let wrapOppWidth = 0;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		const grapheme = seg.segment;
		const gWidth = visibleWidth(grapheme);
		const charIndex = seg.index;
		const isWs = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

		// Overflow check before advancing.
		if (currentWidth + gWidth > maxWidth) {
			if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + gWidth <= maxWidth) {
				// Backtrack to last wrap opportunity (the remaining content
				// plus the current grapheme still fits within maxWidth).
				chunks.push({
					text: line.slice(chunkStart, wrapOppIndex),
					startIndex: chunkStart,
					endIndex: wrapOppIndex,
					width: wrapOppWidth,
				});
				chunkStart = wrapOppIndex;
				currentWidth -= wrapOppWidth;
			} else if (chunkStart < charIndex) {
				// No viable wrap opportunity: force-break at current position.
				// This also handles the case where backtracking to a word
				// boundary wouldn't help because the remaining content plus
				// the current grapheme (e.g. a wide character) still exceeds
				// maxWidth.
				chunks.push({
					text: line.slice(chunkStart, charIndex),
					startIndex: chunkStart,
					endIndex: charIndex,
					width: currentWidth,
				});
				chunkStart = charIndex;
				currentWidth = 0;
			}
			wrapOppIndex = -1;
		}

		if (gWidth > maxWidth) {
			// Single atomic segment wider than maxWidth (e.g. paste marker
			// in a narrow terminal). Re-wrap it at grapheme granularity.

			// The segment remains logically atomic for cursor
			// movement / editing — the split is purely visual for word-wrap layout.
			const subChunks = wordWrapLine(grapheme, maxWidth);
			for (let j = 0; j < subChunks.length - 1; j++) {
				const sc = subChunks[j]!;
				chunks.push({
					text: sc.text,
					startIndex: charIndex + sc.startIndex,
					endIndex: charIndex + sc.endIndex,
					width: sc.width,
				});
			}
			const last = subChunks[subChunks.length - 1]!;
			chunkStart = charIndex + last.startIndex;
			currentWidth = visibleWidth(last.text);
			wrapOppIndex = -1;
			continue;
		}

		// Advance.
		currentWidth += gWidth;

		// Record wrap opportunity: whitespace followed by non-whitespace.
		// Multiple spaces join (no break between them); the break point is
		// after the last space before the next word.
		const next = segments[i + 1];
		if (isWs && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
			wrapOppIndex = next.index;
			wrapOppWidth = currentWidth;
		}
	}

	// Push final chunk.
	chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length, width: currentWidth });

	return chunks;
}

// Kitty CSI-u sequences for printable keys, including optional shifted/base codepoints.
interface EditorState {
	lines: string[];
	cursorLine: number;
	cursorCol: number;
}

interface LayoutLine {
	text: string;
	/** Visible width of `text`; precomputed so render() doesn't rescan per frame. */
	visibleWidth: number;
	hasCursor: boolean;
	cursorPos?: number;
}

export interface EditorTheme {
	borderColor: (str: string) => string;
	selectList: SelectListTheme;
	/**
	 * Optional: colorize the leading `/command` token when the buffer starts a
	 * slash command (e.g. `/chrome`). Omit to leave the command text uncolored.
	 */
	commandColor?: (str: string) => string;
}

export interface EditorOptions {
	paddingX?: number;
	autocompleteMaxVisible?: number;
	/**
	 * Called when a paste exceeds MAX_PASTE_BYTES and is truncated. The editor has
	 * no warning surface of its own, so the consumer plumbs this to its own warning
	 * mechanism (e.g. showWarning). `originalBytes` is the pre-truncation length,
	 * `keptBytes` the length actually inserted.
	 */
	onPasteTruncated?: (info: { originalBytes: number; keptBytes: number }) => void;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

const ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS = 20;
const DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS = 40;
const HISTORY_SEARCH_DEBOUNCE_MS = 30;

/**
 * Max time to wait for one autocomplete request (provider response) and for the
 * previous request in the serialized chain. A provider that hangs (a Promise that
 * never settles) would otherwise wedge the whole `await previousTask` chain and
 * retain its closures; on timeout we abandon that request and let the chain
 * proceed. A fast provider settles well under this, so normal behavior is unchanged.
 */
const AUTOCOMPLETE_REQUEST_TIMEOUT_MS = 4000;

/** Effective autocomplete timeout. Overridable via PIT_AUTOCOMPLETE_TIMEOUT_MS
 * (used by tests to avoid a real multi-second wait); read per call so the env can
 * be set after import. Falls back to the constant when unset/invalid. */
function autocompleteTimeoutMs(): number {
	const raw = Number(process.env.PIT_AUTOCOMPLETE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : AUTOCOMPLETE_REQUEST_TIMEOUT_MS;
}

/** Resolve when `promise` settles or after `ms`, whichever comes first. The
 * timer is cleared on settle so a resolved request leaves no dangling handle. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return new Promise<T | undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			() => {
				clearTimeout(timer);
				resolve(undefined);
			},
		);
	});
}

/** Default half-period of the cursor blink: cursor on for this long, then off
 * for this long (~530ms each, the classic terminal cadence). */
const CURSOR_BLINK_HALF_MS = 530;

// Hoisted: recompiling these per keystroke in insertCharacter is wasteful.
const AUTOCOMPLETE_TRIGGER_CHAR_RE = /[a-zA-Z0-9.\-_]/;
const SYMBOL_COMPLETION_CONTEXT_RE = /(?:^|[\s])[@#][^\s]*$/;
// Control chars to strip from a paste, EXCEPT newline (0x0A): 0x00-0x09 and
// 0x0B-0x1F. Equivalent to the old `char === "\n" || charCode >= 32` filter.
const CONTROL_CHARS_EXCEPT_NEWLINE_RE = /[\x00-\x09\x0b-\x1f]/g;
// Hard cap on a single paste (10 MiB) applied before any full-string pass, so a
// huge blob can't freeze the event loop or OOM the TUI.
const MAX_PASTE_BYTES = 10 * 1024 * 1024;

export class Editor implements Component, Focusable {
	private state: EditorState = {
		lines: [""],
		cursorLine: 0,
		cursorCol: 0,
	};

	/** Focusable interface - set by TUI when focus changes. Backed by an accessor
	 * so cursor blink runs exactly while the editor holds focus (a blurred editor
	 * never keeps the animation ticker awake). */
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		if (this._focused === value) return;
		this._focused = value;
		if (value) {
			this.resetCursorBlink();
			this.subscribeCursorBlink();
		} else {
			this.unsubscribeCursorBlink();
			this.cursorBlinkVisible = true;
		}
	}

	// Cursor blink, opt-in via setCursorBlink(). The phase derives from the shared
	// monotonic clock and the subscription is bound to focus, so an unfocused or
	// blink-disabled editor holds no timer and renders a steady block cursor.
	private cursorBlinkEnabled = false;
	private cursorBlinkHalfMs = CURSOR_BLINK_HALF_MS;
	private cursorBlinkVisible = true;
	private cursorBlinkEpoch = 0;
	private cursorBlinkUnsub: (() => void) | null = null;

	protected tui: TUI;
	private theme: EditorTheme;
	private paddingX: number = 0;

	// Store last render width for cursor navigation
	private lastWidth: number = 80;

	// Vertical scrolling support
	private scrollOffset: number = 0;

	// Word-wrap memo: logical line text -> wrapped chunks. Keyed by content so a
	// single-line edit only misses the changed line (others stay hit). Reset on
	// width change (resize) and paste-validity change, since both alter wrapping.
	// Eliminates per-keystroke Intl.Segmenter + re-wrap of the whole buffer.
	private wrapCache: Map<string, TextChunk[]> = new Map();
	private wrapCacheWidth: number = -1;

	// Structural layout memo: the LayoutLine array with cursor markers cleared
	// (hasCursor: false everywhere). Depends only on (bufferRevision, width) —
	// NOT on cursor position — so arrow-key movement never re-wraps/re-segments
	// the buffer. `structuralLineMeta[i]` gives the slot range in
	// `structuralLayoutLines` for logical line i (see getLayoutLines/
	// applyCursorOverlay). Rebuilt only when content or width changes.
	private structuralLayoutLines: LayoutLine[] | null = null;
	private structuralLineMeta: Array<{ start: number; wrapped: boolean }> = [];
	private structuralLayoutWidth = -1;
	private structuralLayoutRevision = -1;

	// Cursor overlay bookkeeping: the single LayoutLine slot (index into
	// structuralLayoutLines) that currently carries hasCursor/cursorPos, and the
	// (cursorLine, cursorCol) it reflects. A cursor-only move (no content/width
	// change) clears just that slot and sets the new one — O(chunks of the old
	// + new cursor line), not O(all lines).
	private overlaySlotIndex = -1;
	private overlayCursorLine = -1;
	private overlayCursorCol = -1;

	// Bumped on every buffer mutation (see touchBuffer/invalidateWrapCache) so
	// memoized derivations (getText, structural layout, visual-line map) can
	// detect "nothing changed" in O(1) instead of O(chars)/O(lines).
	private bufferRevision = 0;

	// getText() memo: this.state.lines.join("\n") is O(buffer) and is called on
	// every keystroke's onChange plus twice per autocomplete round-trip. Cache
	// the joined text keyed by bufferRevision so repeated calls within the same
	// mutation (or idle re-renders) are O(1).
	private textCache = "";
	private textCacheRevision = -1;

	// buildVisualLineMap() memo: the map depends only on (bufferRevision, width),
	// never on cursor position, so ↑/↓/PageUp/PageDown navigation (which calls it
	// on every keystroke) reuses the cached map instead of re-wrapping all lines.
	private visualLineMapCache: Array<{ logicalLine: number; startCol: number; length: number }> | null = null;
	private visualLineMapWidth = -1;
	private visualLineMapRevision = -1;

	// Border color (can be changed dynamically)
	public borderColor: (str: string) => string;

	// Autocomplete support
	private autocompleteProvider?: AutocompleteProvider;
	private autocompleteList?: SelectList;
	private autocompleteState: "regular" | "force" | null = null;
	private autocompletePrefix: string = "";
	private autocompleteMaxVisible: number = 5;
	private autocompleteAbort?: AbortController;
	private autocompleteDebounceTimer?: ReturnType<typeof setTimeout>;
	private autocompleteRequestTask: Promise<void> = Promise.resolve();
	private autocompleteStartToken: number = 0;
	private autocompleteRequestId: number = 0;

	// Paste tracking for large pastes
	private pastes: Map<number, string> = new Map();
	// Memoized id set for validPasteIds(); rebuilt lazily after pastes mutates.
	// Invalidated on paste add (handlePaste) and clear (submitValue) only — never
	// on cursor moves — so it stays valid across the hot keystroke path.
	private validPasteIdsCache?: Set<number>;
	private pasteCounter: number = 0;
	// Optional consumer callback fired when a paste is truncated at MAX_PASTE_BYTES.
	private onPasteTruncated?: (info: { originalBytes: number; keptBytes: number }) => void;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Prompt history for up/down navigation
	private history: string[] = [];
	private historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.

	// Kill ring for Emacs-style kill/yank operations
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Character jump mode
	private jumpMode: "forward" | "backward" | null = null;

	// Reverse history search (Ctrl+R). When active, an incremental-filter overlay
	// over `history` is shown below the editor; the editor buffer is untouched
	// until the user confirms a pick. null when not searching.
	private historySearchList: SelectList | null = null;
	private historySearchQuery: string = "";
	private historySearchDebounceTimer: ReturnType<typeof setTimeout> | undefined;

	// Preferred visual column for vertical cursor movement (sticky column)
	private preferredVisualCol: number | null = null;

	// When the cursor is snapped to the start of an atomic segment, e.g. a
	// paste marker, cursorCol no longer reflects where the cursor would have
	// landed. This field stores the pre-snap cursorCol so that the next
	// vertical move can resolve it to a visual column on whatever VL it belongs
	// to.
	private snappedFromCursorCol: number | null = null;

	// Undo support. The redo stack mirrors the undo stack: undo pushes the current
	// state here before applying a popped snapshot; redo pops from here. Any NEW
	// edit (via pushUndoSnapshot) clears the redo stack, since the future being
	// redone no longer applies once history diverges.
	private undoStack = new UndoStack<EditorState>();
	private redoStack = new UndoStack<EditorState>();
	// Set while undo()/redo() apply a snapshot so pushUndoSnapshot — which they do
	// NOT call — stays the single place that clears the redo stack on real edits.
	private applyingHistory = false;

	public onSubmit?: (text: string) => void;
	public onChange?: (text: string) => void;
	public disableSubmit: boolean = false;

	constructor(tui: TUI, theme: EditorTheme, options: EditorOptions = {}) {
		this.tui = tui;
		this.theme = theme;
		this.borderColor = theme.borderColor;
		const paddingX = options.paddingX ?? 0;
		this.paddingX = Number.isFinite(paddingX) ? Math.max(0, Math.floor(paddingX)) : 0;
		const maxVisible = options.autocompleteMaxVisible ?? 5;
		this.autocompleteMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		this.onPasteTruncated = options.onPasteTruncated;
	}

	/** Set of currently valid paste IDs, for marker-aware segmentation. */
	private validPasteIds(): Set<number> {
		// Common case: no active pastes. Reuse a shared empty set so the hot path
		// (segment() runs on every backspace/delete/arrow/word-move) allocates nothing.
		if (this.pastes.size === 0) return EMPTY_PASTE_IDS;
		// Active pastes: ids only change on paste/clear (which reset the cache),
		// not on cursor moves, so the cached set is valid across the keystroke path.
		if (this.validPasteIdsCache === undefined) {
			this.validPasteIdsCache = new Set(this.pastes.keys());
		}
		return this.validPasteIdsCache;
	}

	/** Segment text with paste-marker awareness, only merging markers with valid IDs. */
	private segment(text: string): Iterable<Intl.SegmentData> {
		return segmentWithMarkers(text, this.validPasteIds());
	}

	/**
	 * Word-wrap a logical line, memoized by (width, content). The cache key is the
	 * line text, so unchanged lines are served without re-segmenting/re-wrapping.
	 * Returned arrays are read-only to callers (layoutText / buildVisualLineMap).
	 */
	private wrapLineCached(line: string, contentWidth: number): TextChunk[] {
		if (contentWidth !== this.wrapCacheWidth) {
			this.wrapCache.clear();
			this.wrapCacheWidth = contentWidth;
		}
		const cached = this.wrapCache.get(line);
		if (cached) return cached;
		const chunks = wordWrapLine(line, contentWidth, [...this.segment(line)]);
		// Bound memory; drafts are small so this rarely trips.
		if (this.wrapCache.size >= 4096) this.wrapCache.clear();
		this.wrapCache.set(line, chunks);
		return chunks;
	}

	/** Drop the word-wrap memo (paste-validity changes alter segmentation). */
	private invalidateWrapCache(): void {
		this.bufferRevision++;
		this.wrapCache.clear();
		this.wrapCacheWidth = -1;
	}

	private touchBuffer(): void {
		this.bufferRevision++;
	}

	/**
	 * Layout lines for render(), memoized in two layers:
	 *  - Structural layout (text/width/wrap boundaries) depends only on
	 *    (bufferRevision, width). Rebuilding it re-wraps every logical line, so
	 *    it's skipped entirely when neither content nor width changed.
	 *  - Cursor overlay (which slot has hasCursor/cursorPos) is applied on top,
	 *    touching only the previous and new cursor line's slots — never a full
	 *    re-scan of the buffer, so arrow-key movement is O(1)-ish regardless of
	 *    buffer size.
	 *
	 * The empty-editor case (single empty line) is a fixed invariant — cursor is
	 * always (0,0) — so it's cached structurally with hasCursor baked in and
	 * never touches the overlay bookkeeping below.
	 */
	private getLayoutLines(contentWidth: number): LayoutLine[] {
		if (this.isEditorEmpty()) {
			if (
				!this.structuralLayoutLines ||
				this.structuralLayoutWidth !== contentWidth ||
				this.structuralLayoutRevision !== this.bufferRevision
			) {
				this.structuralLayoutLines = [{ text: "", visibleWidth: 0, hasCursor: true, cursorPos: 0 }];
				this.structuralLineMeta = [];
				this.structuralLayoutWidth = contentWidth;
				this.structuralLayoutRevision = this.bufferRevision;
			}
			return this.structuralLayoutLines;
		}

		const structuralChanged =
			!this.structuralLayoutLines ||
			this.structuralLayoutWidth !== contentWidth ||
			this.structuralLayoutRevision !== this.bufferRevision;

		if (structuralChanged) {
			const { lines, meta } = this.buildStructuralLayout(contentWidth);
			this.structuralLayoutLines = lines;
			this.structuralLineMeta = meta;
			this.structuralLayoutWidth = contentWidth;
			this.structuralLayoutRevision = this.bufferRevision;
			// The new array starts with hasCursor:false everywhere; force the
			// overlay below to (re)apply against it.
			this.overlaySlotIndex = -1;
			this.overlayCursorLine = -1;
			this.overlayCursorCol = -1;
		}

		// Guaranteed non-null: either it was already set (structuralChanged was
		// false) or the branch above just assigned it.
		const lines = this.structuralLayoutLines!;
		if (this.overlayCursorLine === this.state.cursorLine && this.overlayCursorCol === this.state.cursorCol) {
			return lines;
		}

		// Clear the previously-applied cursor slot (if any), then apply the new one.
		if (this.overlaySlotIndex >= 0) {
			const prev = lines[this.overlaySlotIndex];
			if (prev) {
				prev.hasCursor = false;
				prev.cursorPos = undefined;
			}
		}
		this.overlaySlotIndex = this.applyCursorOverlay(
			lines,
			this.structuralLineMeta[this.state.cursorLine],
			contentWidth,
		);
		this.overlayCursorLine = this.state.cursorLine;
		this.overlayCursorCol = this.state.cursorCol;
		return lines;
	}

	getPaddingX(): number {
		return this.paddingX;
	}

	setPaddingX(padding: number): void {
		const newPadding = Number.isFinite(padding) ? Math.max(0, Math.floor(padding)) : 0;
		if (this.paddingX !== newPadding) {
			this.paddingX = newPadding;
			this.tui.requestRender();
		}
	}

	getAutocompleteMaxVisible(): number {
		return this.autocompleteMaxVisible;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		const newMaxVisible = Number.isFinite(maxVisible) ? Math.max(3, Math.min(20, Math.floor(maxVisible))) : 5;
		if (this.autocompleteMaxVisible !== newMaxVisible) {
			this.autocompleteMaxVisible = newMaxVisible;
			this.tui.requestRender();
		}
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.cancelAutocomplete();
		this.autocompleteProvider = provider;
	}

	/**
	 * Add a prompt to history for up/down arrow navigation.
	 * Called after successful submission.
	 */
	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		// Don't add consecutive duplicates
		if (this.history.length > 0 && this.history[0] === trimmed) return;
		this.history.unshift(trimmed);
		// Limit history size
		if (this.history.length > 100) {
			this.history.pop();
		}
	}

	private isEditorEmpty(): boolean {
		return this.state.lines.length === 1 && this.state.lines[0] === "";
	}

	private isOnFirstVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = this.buildVisualLineMap(
			this.lastWidth,
		),
	): boolean {
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === 0;
	}

	private isOnLastVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = this.buildVisualLineMap(
			this.lastWidth,
		),
	): boolean {
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		return currentVisualLine === visualLines.length - 1;
	}

	private navigateHistory(direction: 1 | -1): void {
		this.lastAction = null;
		if (this.history.length === 0) return;

		const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
		if (newIndex < -1 || newIndex >= this.history.length) return;

		// Capture state when first entering history browsing mode
		if (this.historyIndex === -1 && newIndex >= 0) {
			this.pushUndoSnapshot();
		}

		this.historyIndex = newIndex;

		if (this.historyIndex === -1) {
			// Returned to "current" state - clear editor
			this.setTextInternal("");
		} else {
			this.setTextInternal(this.history[this.historyIndex] || "");
		}
	}

	/** Internal setText that doesn't reset history state - used by navigateHistory */
	private setTextInternal(text: string): void {
		const lines = text.split("\n");
		this.state.lines = lines.length === 0 ? [""] : lines;
		this.state.cursorLine = this.state.lines.length - 1;
		this.setCursorCol(this.state.lines[this.state.cursorLine]?.length || 0);
		// Reset scroll - render() will adjust to show cursor
		this.scrollOffset = 0;

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	invalidate(): void {
		this.invalidateWrapCache();
	}

	/**
	 * Wrap the first `maxCols` visible columns of `s` with `colorFn`, skipping
	 * ANSI escape codes and the zero-width cursor marker (they carry no width).
	 * Each plain run is colored independently, so an embedded reverse-video
	 * cursor (…\x1b[7m g \x1b[0m…) survives and the color resumes after it.
	 * Visible width is unchanged — only SGR codes are added — so the upstream
	 * padding math still holds.
	 */
	private paintPrefixVisible(s: string, maxCols: number, colorFn: (t: string) => string): string {
		if (maxCols <= 0) return s;
		// Segment the whole string once up front instead of re-slicing and
		// re-segmenting the remainder on every grapheme (that was O(n^2) on the
		// painted prefix: each iteration re-scanned from i to the end). Grapheme
		// boundary rules only look at local context, so segmenting from 0 and
		// reading off the boundary at index i agrees with segmenting from i.
		const segments = [...this.segment(s)];
		let segIdx = 0;
		let out = "";
		let run = "";
		let cols = 0;
		let i = 0;
		const flushRun = () => {
			if (run) {
				out += colorFn(run);
				run = "";
			}
		};
		while (i < s.length && cols < maxCols) {
			// Skip segments consumed by a previous ANSI run or otherwise behind i.
			while (segIdx < segments.length && segments[segIdx]!.index < i) segIdx++;
			const esc = extractAnsiCode(s, i);
			if (esc) {
				flushRun();
				out += esc.code;
				i += esc.length;
				continue;
			}
			const seg = segIdx < segments.length ? segments[segIdx] : undefined;
			const grapheme = seg && seg.index === i ? seg.segment : s[i]!;
			const w = visibleWidth(grapheme);
			if (cols + w > maxCols) break; // never split a wide glyph across the boundary
			run += grapheme;
			cols += w;
			i += grapheme.length;
			segIdx++;
		}
		flushRun();
		return out + s.slice(i);
	}

	render(width: number): string[] {
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.paddingX, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);

		// Layout width: with padding the cursor can overflow into it,
		// without padding we reserve 1 column for the cursor.
		const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));

		// Store for cursor navigation (must match wrapping width)
		this.lastWidth = layoutWidth;

		// Pre-color the full-width rule with a single SGR pair instead of coloring
		// each "─" and repeating the colored unit: the border color is uniform, so
		// per-glyph coloring just bloats every repaint (~one escape pair per column).
		// A rounded corner opens the top rule (`╭`); no right corner since there are
		// no side borders. Width is unchanged — only the first glyph differs.
		const horizontalRule = this.borderColor(`╭${"─".repeat(Math.max(0, width - 1))}`);

		// Layout the text. Optional perf probe: set PIT_EDITOR_PERF=1 to log layout
		// cost per render (use with a realistic multi-line / CJK draft to measure
		// the word-wrap cache win). Zero overhead when the env var is unset.
		let layoutLines: LayoutLine[];
		if (process.env.PIT_EDITOR_PERF) {
			const t0 = performance.now();
			layoutLines = this.getLayoutLines(layoutWidth);
			const dt = performance.now() - t0;
			process.stderr.write(
				`[editor-perf] layout ${dt.toFixed(3)}ms lines=${this.state.lines.length} w=${layoutWidth} cache=${this.wrapCache.size}\n`,
			);
		} else {
			layoutLines = this.getLayoutLines(layoutWidth);
		}

		// Calculate max visible lines: 30% of terminal height, minimum 5 lines
		const terminalRows = this.tui.terminal.rows;
		const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));

		// Find the cursor line index in layoutLines
		let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
		if (cursorLineIndex === -1) cursorLineIndex = 0;

		// Adjust scroll offset to keep cursor visible
		if (cursorLineIndex < this.scrollOffset) {
			this.scrollOffset = cursorLineIndex;
		} else if (cursorLineIndex >= this.scrollOffset + maxVisibleLines) {
			this.scrollOffset = cursorLineIndex - maxVisibleLines + 1;
		}

		// Clamp scroll offset to valid range
		const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
		this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxScrollOffset));

		// Get visible lines slice
		const visibleLines = layoutLines.slice(this.scrollOffset, this.scrollOffset + maxVisibleLines);

		const result: string[] = [];
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;

		// Render top border. Priorities, all reusing the same border-rule mechanism:
		//  - jump mode active: show an ephemeral `─── jump → ` cue so the editor
		//    doesn't look frozen while it waits for the target character. When also
		//    scrolled, the scroll count is appended so neither signal is lost.
		//  - scrolled (no jump): the usual `─── ↑ N more ` indicator.
		//  - otherwise: the plain horizontal rule.
		if (this.jumpMode !== null) {
			const arrow = this.jumpMode === "forward" ? "→" : "←";
			const scrollSuffix = this.scrollOffset > 0 ? `↑ ${this.scrollOffset} more ` : "";
			// Open with the rounded corner `╭`; the indicator otherwise starts `─── `,
			// so swapping the leading glyph keeps the visible width identical.
			const indicator = `╭── jump ${arrow} ${scrollSuffix}`;
			const remaining = width - visibleWidth(indicator);
			if (remaining >= 0) {
				result.push(this.borderColor(indicator + "─".repeat(remaining)));
			} else {
				result.push(this.borderColor(truncateToWidth(indicator, width)));
			}
		} else if (this.scrollOffset > 0) {
			const indicator = `╭── ↑ ${this.scrollOffset} more `;
			const remaining = width - visibleWidth(indicator);
			if (remaining >= 0) {
				result.push(this.borderColor(indicator + "─".repeat(remaining)));
			} else {
				result.push(this.borderColor(truncateToWidth(indicator, width)));
			}
		} else {
			result.push(horizontalRule);
		}

		// Render each visible layout line
		// Emit hardware cursor marker only when focused and not showing autocomplete
		const emitCursorMarker = this.focused && !this.autocompleteState && !this.historySearchList;

		// Slash-command highlight: column width of the leading `/command` token on
		// the first line. Only when not scrolled — the command always lives at the
		// buffer start, i.e. the first visible layout line.
		let commandCols = 0;
		if (this.theme.commandColor && this.scrollOffset === 0) {
			const match = /^\/[^\s/]\S*/.exec(this.state.lines[0] ?? "");
			if (match) commandCols = visibleWidth(match[0]);
		}

		for (const [visibleIndex, layoutLine] of visibleLines.entries()) {
			let displayText = layoutLine.text;
			let lineVisibleWidth = layoutLine.visibleWidth;
			let cursorInPadding = false;

			// Add cursor if this line has it
			if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
				const before = displayText.slice(0, layoutLine.cursorPos);
				const after = displayText.slice(layoutLine.cursorPos);

				// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
				const marker = emitCursorMarker ? CURSOR_MARKER : "";
				// During the blink "off" half, draw the glyph plainly (no reverse video)
				// so the cursor visually disappears; the hardware marker stays for IME.
				const blinkOff = this.cursorBlinkEnabled && !this.cursorBlinkVisible;

				if (after.length > 0) {
					// Cursor is on a character (grapheme) - replace it with highlighted version
					// Get the first grapheme from 'after'
					// Iterator avoids materializing the full grapheme array per-frame;
					// only the first cluster is read.
					const firstGrapheme = this.segment(after)[Symbol.iterator]().next().value?.segment || "";
					const restAfter = after.slice(firstGrapheme.length);
					const cursor = blinkOff ? firstGrapheme : `\x1b[7m${firstGrapheme}\x1b[0m`;
					displayText = before + marker + cursor + restAfter;
					// lineVisibleWidth stays the same - we're replacing, not adding
				} else {
					// Cursor is at the end - add highlighted space
					const cursor = blinkOff ? " " : "\x1b[7m \x1b[0m";
					displayText = before + marker + cursor;
					lineVisibleWidth = lineVisibleWidth + 1;
					// If cursor overflows content width into the padding, flag it
					if (lineVisibleWidth > contentWidth && paddingX > 0) {
						cursorInPadding = true;
					}
				}
			}

			// Colorize the leading slash-command token on the first line (after
			// cursor injection so the reverse-video cursor stays intact).
			if (commandCols > 0 && visibleIndex === 0 && this.theme.commandColor) {
				displayText = this.paintPrefixVisible(displayText, commandCols, this.theme.commandColor);
			}

			// Calculate padding based on actual visible width
			const padding = " ".repeat(Math.max(0, contentWidth - lineVisibleWidth));
			const lineRightPadding = cursorInPadding ? rightPadding.slice(1) : rightPadding;

			// Render the line (no side borders, just horizontal lines above and below)
			result.push(`${leftPadding}${displayText}${padding}${lineRightPadding}`);
		}

		// Bottom edge. A second full-width rule directly above the footer was pure
		// weight — the top rule already separates the chat from the input, and the
		// footer below carries its own structure. So the bottom rule renders ONLY
		// when it carries information (`↓ N more` scroll indicator); otherwise it
		// collapses to a blank line, letting whitespace do the separating.
		const linesBelow = layoutLines.length - (this.scrollOffset + visibleLines.length);
		if (linesBelow > 0) {
			// Rounded corner `╰` opens the bottom rule; same width as the old `─── `.
			const indicator = `╰── ↓ ${linesBelow} more `;
			const remaining = width - visibleWidth(indicator);
			if (remaining >= 0) {
				result.push(this.borderColor(indicator + "─".repeat(remaining)));
			} else {
				result.push(this.borderColor(truncateToWidth(indicator, width)));
			}
		} else {
			result.push("");
		}

		// Add autocomplete list if active
		if (this.autocompleteState && this.autocompleteList) {
			const autocompleteResult = this.autocompleteList.render(contentWidth);
			for (const line of autocompleteResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		// Reverse history search overlay (Ctrl+R). Rendered below the editor with a
		// dim header echoing the live query, then the filtered SelectList.
		if (this.historySearchList) {
			const headerText = truncateToWidth(`  history ⌕ ${this.historySearchQuery}`, contentWidth, "…");
			const header = this.theme.selectList.scrollInfo(headerText);
			const headerPad = " ".repeat(Math.max(0, contentWidth - visibleWidth(header)));
			result.push(`${leftPadding}${header}${headerPad}${rightPadding}`);

			const searchResult = this.historySearchList.render(contentWidth);
			for (const line of searchResult) {
				const lineWidth = visibleWidth(line);
				const linePadding = " ".repeat(Math.max(0, contentWidth - lineWidth));
				result.push(`${leftPadding}${line}${linePadding}${rightPadding}`);
			}
		}

		return result;
	}

	/**
	 * Enable or disable cursor blink. When enabled and focused, the block cursor
	 * toggles every `halfPeriodMs` (default 530ms) off the shared animation ticker;
	 * the subscription is bound to focus so a blurred editor holds no timer.
	 * Disabling leaves the cursor steady.
	 */
	setCursorBlink(enabled: boolean, halfPeriodMs?: number): void {
		this.cursorBlinkEnabled = enabled;
		if (halfPeriodMs !== undefined && halfPeriodMs > 0) {
			this.cursorBlinkHalfMs = halfPeriodMs;
		}
		if (enabled && this._focused) {
			this.resetCursorBlink();
			this.subscribeCursorBlink();
		} else {
			this.unsubscribeCursorBlink();
			this.cursorBlinkVisible = true;
		}
		this.tui.requestRender();
	}

	private subscribeCursorBlink(): void {
		if (this.cursorBlinkUnsub || !this.cursorBlinkEnabled) return;
		this.cursorBlinkUnsub = this.tui.addAnimationCallback((now) => this.blinkTick(now));
	}

	private unsubscribeCursorBlink(): void {
		if (this.cursorBlinkUnsub) {
			this.cursorBlinkUnsub();
			this.cursorBlinkUnsub = null;
		}
	}

	/** Restart the blink cycle solid-on — called on focus and on input so the
	 * cursor is steady right after activity, like a conventional editor. */
	private resetCursorBlink(): void {
		this.cursorBlinkEpoch = performance.now();
		this.cursorBlinkVisible = true;
	}

	/** Ticker callback: flip the blink phase from the shared clock; returns true
	 * only when the visible state changed so the ticker coalesces one render. */
	private blinkTick(now: number): boolean {
		if (!this.cursorBlinkEnabled || !this._focused) {
			if (!this.cursorBlinkVisible) {
				this.cursorBlinkVisible = true;
				return true;
			}
			return false;
		}
		const visible = Math.floor((now - this.cursorBlinkEpoch) / this.cursorBlinkHalfMs) % 2 === 0;
		if (visible === this.cursorBlinkVisible) return false;
		this.cursorBlinkVisible = visible;
		return true;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		// Keep the cursor solid immediately after any keystroke.
		if (this.cursorBlinkEnabled && this._focused) this.resetCursorBlink();

		// Handle character jump mode (awaiting next character to jump to)
		if (this.jumpMode !== null) {
			// Cancel if the hotkey is pressed again
			if (kb.matches(data, "tui.editor.jumpForward") || kb.matches(data, "tui.editor.jumpBackward")) {
				this.jumpMode = null;
				return;
			}

			const printable = decodePrintableKey(data) ?? (data.charCodeAt(0) >= 32 ? data : undefined);
			if (printable !== undefined) {
				// Printable character - perform the jump
				const direction = this.jumpMode;
				this.jumpMode = null;
				this.jumpToChar(printable, direction);
				return;
			}

			// Control character - cancel and fall through to normal handling
			this.jumpMode = null;
		}

		// Handle bracketed paste mode
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		if (this.isInPaste) {
			// Search only from near the previous tail: the end marker can't begin
			// before (prevLen - (marker.length - 1)) without having already been
			// found on a prior chunk, so re-scanning the whole accumulated buffer
			// every chunk (O(n^2) over a byte-at-a-time paste) is wasted work.
			// Mirrors the windowed search in stdin-buffer.ts.
			const prevLen = this.pasteBuffer.length;
			this.pasteBuffer += data;
			const searchFrom = Math.max(0, prevLen - 5); // "\x1b[201~".length - 1 = 5
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~", searchFrom);
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				if (pasteContent.length > 0) {
					this.handlePaste(pasteContent);
				}
				this.isInPaste = false;
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";
				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			}
			// Guard against an unterminated paste: a paste interrupted before the
			// end marker (\x1b[201~) arrives — or a terminal that never emits one,
			// or a blob sliced across chunks that overshoots — would let pasteBuffer
			// grow without bound, eventually OOMing or hanging (subsequent input is
			// swallowed because we stay in paste mode forever). Once we have clearly
			// exceeded the cap with no end marker in sight, flush what we have
			// (handlePaste truncates at MAX_PASTE_BYTES) and exit paste mode.
			if (this.pasteBuffer.length > MAX_PASTE_BYTES) {
				const pasteContent = this.pasteBuffer;
				this.isInPaste = false;
				this.pasteBuffer = "";
				if (pasteContent.length > 0) {
					this.handlePaste(pasteContent);
				}
				return;
			}
			return;
		}

		// Reverse history search overlay: while open it owns all input.
		if (this.historySearchList) {
			this.handleHistorySearchInput(data, kb);
			return;
		}

		// Ctrl+C - let parent handle (exit/clear)
		if (kb.matches(data, "tui.input.copy")) {
			return;
		}

		// Redo (checked before undo: ctrl+shift+- is a superset of ctrl+-'s modifiers)
		if (kb.matches(data, "tui.editor.redo")) {
			this.redo();
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// Handle autocomplete mode
		if (this.autocompleteState && this.autocompleteList) {
			if (kb.matches(data, "tui.select.cancel")) {
				this.cancelAutocomplete();
				return;
			}

			if (kb.matches(data, "tui.select.up") || kb.matches(data, "tui.select.down")) {
				this.autocompleteList.handleInput(data);
				return;
			}

			if (kb.matches(data, "tui.input.tab")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);
					this.touchBuffer();
					this.cancelAutocomplete();
					if (this.onChange) this.onChange(this.getText());
				}
				return;
			}

			if (kb.matches(data, "tui.select.confirm")) {
				const selected = this.autocompleteList.getSelectedItem();
				if (selected && this.autocompleteProvider) {
					this.pushUndoSnapshot();
					this.lastAction = null;
					const result = this.autocompleteProvider.applyCompletion(
						this.state.lines,
						this.state.cursorLine,
						this.state.cursorCol,
						selected,
						this.autocompletePrefix,
					);
					this.state.lines = result.lines;
					this.state.cursorLine = result.cursorLine;
					this.setCursorCol(result.cursorCol);
					this.touchBuffer();

					if (this.autocompletePrefix.startsWith("/")) {
						this.cancelAutocomplete();
						// Fall through to submit
					} else {
						this.cancelAutocomplete();
						if (this.onChange) this.onChange(this.getText());
						return;
					}
				}
			}
		}

		// Tab - trigger completion
		if (kb.matches(data, "tui.input.tab") && !this.autocompleteState) {
			this.handleTabCompletion();
			return;
		}

		// Deletion actions
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToEndOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToStartOfLine();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			this.deleteWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordForward")) {
			this.deleteWordForward();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.handleBackspace();
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharForward") || matchesKey(data, "shift+delete")) {
			this.handleForwardDelete();
			return;
		}

		// Kill ring actions
		if (kb.matches(data, "tui.editor.yank")) {
			this.yank();
			return;
		}
		if (kb.matches(data, "tui.editor.yankPop")) {
			this.yankPop();
			return;
		}

		// Cursor movement actions
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.moveToLineStart();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.moveToLineEnd();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordLeft")) {
			this.moveWordBackwards();
			return;
		}
		if (kb.matches(data, "tui.editor.cursorWordRight")) {
			this.moveWordForwards();
			return;
		}

		// New line
		if (
			kb.matches(data, "tui.input.newLine") ||
			(data.charCodeAt(0) === 10 && data.length > 1) ||
			data === "\x1b\r" ||
			data === "\x1b[13;2~" ||
			(data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
			(data === "\n" && data.length === 1)
		) {
			if (this.shouldSubmitOnBackslashEnter(data, kb)) {
				this.handleBackspace();
				this.submitValue();
				return;
			}
			this.addNewLine();
			return;
		}

		// Submit (Enter)
		if (kb.matches(data, "tui.input.submit")) {
			if (this.disableSubmit) return;

			// Workaround for terminals without Shift+Enter support:
			// If char before cursor is \, delete it and insert newline instead of submitting.
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			if (this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\") {
				this.handleBackspace();
				this.addNewLine();
				return;
			}

			this.submitValue();
			return;
		}

		// Arrow key navigation (with history support)
		if (kb.matches(data, "tui.editor.cursorUp")) {
			if (this.isEditorEmpty()) {
				this.navigateHistory(-1);
			} else {
				// Build the visual-line map once and reuse it for the
				// first-line checks and the cursor move (avoids 2-3 rebuilds/key).
				const visualLines = this.buildVisualLineMap(this.lastWidth);
				if (this.historyIndex > -1 && this.isOnFirstVisualLine(visualLines)) {
					this.navigateHistory(-1);
				} else if (this.isOnFirstVisualLine(visualLines)) {
					// Already at top - jump to start of line
					this.moveToLineStart();
				} else {
					this.moveCursor(-1, 0, visualLines);
				}
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorDown")) {
			const visualLines = this.buildVisualLineMap(this.lastWidth);
			if (this.historyIndex > -1 && this.isOnLastVisualLine(visualLines)) {
				this.navigateHistory(1);
			} else if (this.isOnLastVisualLine(visualLines)) {
				// Already at bottom - jump to end of line
				this.moveToLineEnd();
			} else {
				this.moveCursor(1, 0, visualLines);
			}
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.moveCursor(0, 1);
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.moveCursor(0, -1);
			return;
		}

		// Page up/down - scroll by page and move cursor
		if (kb.matches(data, "tui.editor.pageUp")) {
			this.pageScroll(-1);
			return;
		}
		if (kb.matches(data, "tui.editor.pageDown")) {
			this.pageScroll(1);
			return;
		}

		// Reverse history search (Ctrl+R)
		if (kb.matches(data, "tui.editor.historySearch")) {
			this.openHistorySearch();
			return;
		}

		// Character jump mode triggers
		if (kb.matches(data, "tui.editor.jumpForward")) {
			this.jumpMode = "forward";
			return;
		}
		if (kb.matches(data, "tui.editor.jumpBackward")) {
			this.jumpMode = "backward";
			return;
		}

		// Shift+Space - insert regular space
		if (matchesKey(data, "shift+space")) {
			this.insertCharacter(" ");
			return;
		}

		const printable = decodePrintableKey(data);
		if (printable !== undefined) {
			this.insertCharacter(printable);
			return;
		}

		// Regular characters
		if (data.charCodeAt(0) >= 32) {
			this.insertCharacter(data);
		}
	}

	/**
	 * Build the cursor-independent layout: for each logical line, either a
	 * single fitting entry or its word-wrapped chunks, all with hasCursor:false.
	 * Callers (getLayoutLines) overlay the cursor afterwards. Assumes the
	 * editor is non-empty — the empty-editor case is handled separately since
	 * it's a fixed invariant that doesn't need the overlay machinery.
	 *
	 * `meta[i]` records where logical line i's entries start in the returned
	 * array (and whether it wrapped into multiple entries), so the overlay can
	 * jump straight to the cursor's line without scanning the whole buffer.
	 */
	private buildStructuralLayout(contentWidth: number): {
		lines: LayoutLine[];
		meta: Array<{ start: number; wrapped: boolean }>;
	} {
		const layoutLines: LayoutLine[] = [];
		const meta: Array<{ start: number; wrapped: boolean }> = [];

		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const lineVisibleWidth = visibleWidth(line);
			const start = layoutLines.length;

			if (lineVisibleWidth <= contentWidth) {
				layoutLines.push({ text: line, visibleWidth: lineVisibleWidth, hasCursor: false });
				meta.push({ start, wrapped: false });
			} else {
				// Line needs wrapping - use word-aware wrapping
				const chunks = this.wrapLineCached(line, contentWidth);
				for (const chunk of chunks) {
					layoutLines.push({ text: chunk.text, visibleWidth: chunk.width, hasCursor: false });
				}
				meta.push({ start, wrapped: true });
			}
		}

		return { lines: layoutLines, meta };
	}

	/**
	 * Apply the current cursor position onto one logical line's slot(s) in an
	 * already-built structural layout, mutating the affected LayoutLine entry
	 * in place. Returns the absolute index of the entry that now carries the
	 * cursor (or -1 if the line has no entries, which shouldn't happen).
	 *
	 * The chunk-matching logic mirrors the previous single-pass layoutText()
	 * exactly (same isLastChunk / startIndex / endIndex comparisons), just
	 * scoped to only the current cursor's logical line instead of every line.
	 */
	private applyCursorOverlay(
		lines: LayoutLine[],
		lineMeta: { start: number; wrapped: boolean } | undefined,
		contentWidth: number,
	): number {
		if (!lineMeta) return -1;
		const cursorLineIdx = this.state.cursorLine;
		const cursorPos = this.state.cursorCol;

		if (!lineMeta.wrapped) {
			const entry = lines[lineMeta.start];
			if (!entry) return -1;
			entry.hasCursor = true;
			entry.cursorPos = cursorPos;
			return lineMeta.start;
		}

		const line = this.state.lines[cursorLineIdx] || "";
		const chunks = this.wrapLineCached(line, contentWidth);

		for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
			const chunk = chunks[chunkIndex];
			if (!chunk) continue;
			const isLastChunk = chunkIndex === chunks.length - 1;

			let hasCursorInChunk: boolean;
			let adjustedCursorPos = 0;
			if (isLastChunk) {
				// Last chunk: cursor belongs here if >= startIndex
				hasCursorInChunk = cursorPos >= chunk.startIndex;
				adjustedCursorPos = cursorPos - chunk.startIndex;
			} else {
				// Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
				// But we need to handle the visual position in the trimmed text
				hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
				if (hasCursorInChunk) {
					adjustedCursorPos = cursorPos - chunk.startIndex;
					// Clamp to text length (in case cursor was in trimmed whitespace)
					if (adjustedCursorPos > chunk.text.length) {
						adjustedCursorPos = chunk.text.length;
					}
				}
			}

			if (hasCursorInChunk) {
				const slot = lineMeta.start + chunkIndex;
				const entry = lines[slot];
				if (!entry) return -1;
				entry.hasCursor = true;
				entry.cursorPos = adjustedCursorPos;
				return slot;
			}
		}

		return -1;
	}

	getText(): string {
		if (this.textCacheRevision !== this.bufferRevision) {
			this.textCache = this.state.lines.join("\n");
			this.textCacheRevision = this.bufferRevision;
		}
		return this.textCache;
	}

	private expandPasteMarkers(text: string): string {
		// Single pass: one combined regex matches every paste marker; the replacer
		// looks up the stored content by id, falling back to the original match when
		// the id is unknown. Avoids compiling N regexes / scanning the text N times.
		const markerRegex = /\[paste #(\d+)( (?:\+\d+ lines|\d+ chars))?\]/g;
		return text.replace(markerRegex, (match, id: string) => {
			const pasteContent = this.pastes.get(Number(id));
			return pasteContent === undefined ? match : pasteContent;
		});
	}

	/**
	 * Get text with paste markers expanded to their actual content.
	 * Use this when you need the full content (e.g., for external editor).
	 */
	getExpandedText(): string {
		return this.expandPasteMarkers(this.state.lines.join("\n"));
	}

	getLines(): string[] {
		return [...this.state.lines];
	}

	getCursor(): { line: number; col: number } {
		return { line: this.state.cursorLine, col: this.state.cursorCol };
	}

	setText(text: string): void {
		this.cancelAutocomplete();
		this.lastAction = null;
		this.historyIndex = -1; // Exit history browsing mode
		const normalized = this.normalizeText(text);
		// Push undo snapshot if content differs (makes programmatic changes undoable)
		if (this.getText() !== normalized) {
			this.pushUndoSnapshot();
		}
		this.setTextInternal(normalized);
	}

	/**
	 * Insert text at the current cursor position.
	 * Used for programmatic insertion (e.g., clipboard image markers).
	 * This is atomic for undo - single undo restores entire pre-insert state.
	 */
	insertTextAtCursor(text: string): void {
		if (!text) return;
		this.cancelAutocomplete();
		this.pushUndoSnapshot();
		this.lastAction = null;
		this.historyIndex = -1;
		this.insertTextAtCursorInternal(text);
	}

	/**
	 * Normalize text for editor storage:
	 * - Normalize line endings (\r\n and \r -> \n)
	 * - Expand tabs to 4 spaces
	 */
	private normalizeText(text: string): string {
		return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	}

	/**
	 * Internal text insertion at cursor. Handles single and multi-line text.
	 * Does not push undo snapshots or trigger autocomplete - caller is responsible.
	 * Normalizes line endings and calls onChange once at the end.
	 */
	private insertTextAtCursorInternal(text: string): void {
		if (!text) return;

		// Normalize line endings and tabs
		const normalized = this.normalizeText(text);
		const insertedLines = normalized.split("\n");

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		const afterCursor = currentLine.slice(this.state.cursorCol);

		if (insertedLines.length === 1) {
			// Single line - insert at cursor position
			this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
			this.setCursorCol(this.state.cursorCol + normalized.length);
		} else {
			// Multi-line insertion
			this.state.lines = [
				// All lines before current line
				...this.state.lines.slice(0, this.state.cursorLine),

				// The first inserted line merged with text before cursor
				beforeCursor + insertedLines[0],

				// All middle inserted lines
				...insertedLines.slice(1, -1),

				// The last inserted line with text after cursor
				insertedLines[insertedLines.length - 1] + afterCursor,

				// All lines after current line
				...this.state.lines.slice(this.state.cursorLine + 1),
			];

			this.state.cursorLine += insertedLines.length - 1;
			this.setCursorCol((insertedLines[insertedLines.length - 1] || "").length);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	// All the editor methods from before...
	private insertCharacter(char: string, skipUndoCoalescing?: boolean): void {
		this.historyIndex = -1; // Exit history browsing mode

		// Undo coalescing (fish-style):
		// - Consecutive word chars coalesce into one undo unit
		// - Space captures state before itself (so undo removes space+following word together)
		// - Each space is separately undoable
		// Skip coalescing when called from atomic operations (e.g., handlePaste)
		if (!skipUndoCoalescing) {
			if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
				this.pushUndoSnapshot();
			}
			this.lastAction = "type-word";
		}

		const line = this.state.lines[this.state.cursorLine] || "";

		const before = line.slice(0, this.state.cursorCol);
		const after = line.slice(this.state.cursorCol);

		this.state.lines[this.state.cursorLine] = before + char + after;
		this.setCursorCol(this.state.cursorCol + char.length);

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Check if we should trigger or update autocomplete
		if (!this.autocompleteState) {
			// Auto-trigger for "/" at the start of a line (slash commands)
			if (char === "/" && this.isAtStartOfMessage()) {
				this.tryTriggerAutocomplete();
			}
			// Auto-trigger for symbol-based completion like @ or # at token boundaries
			else if (char === "@" || char === "#") {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				const charBeforeSymbol = textBeforeCursor[textBeforeCursor.length - 2];
				if (textBeforeCursor.length === 1 || charBeforeSymbol === " " || charBeforeSymbol === "\t") {
					this.tryTriggerAutocomplete();
				}
			}
			// Also auto-trigger when typing letters in a slash command or symbol completion context
			else if (AUTOCOMPLETE_TRIGGER_CHAR_RE.test(char)) {
				const currentLine = this.state.lines[this.state.cursorLine] || "";
				const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
				// Check if we're in a slash command (with or without space for arguments)
				if (this.isInSlashCommandContext(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
				// Check if we're in a symbol-based completion context like @ or #
				else if (SYMBOL_COMPLETION_CONTEXT_RE.test(textBeforeCursor)) {
					this.tryTriggerAutocomplete();
				}
			}
		} else {
			this.updateAutocomplete();
		}
	}

	private handlePaste(pastedText: string): void {
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		// Cap the paste BEFORE any full-string pass. A multi-MB blob (base64, log,
		// file dump) would otherwise block the event loop or OOM in the passes
		// below — the marker branch only kicks in after the cost is already paid.
		// The editor has no warning surface; the consumer's onPasteTruncated (if
		// provided) surfaces the truncation, and the marker branch still summarizes.
		const wasTruncated = pastedText.length > MAX_PASTE_BYTES;
		const cappedText = wasTruncated ? pastedText.slice(0, MAX_PASTE_BYTES) : pastedText;
		if (wasTruncated) {
			this.onPasteTruncated?.({ originalBytes: pastedText.length, keptBytes: cappedText.length });
		}

		// Decode CSI-u-encoded control bytes some terminals inject into pastes
		// (see decodeBracketedPasteCsiU) before the per-char filter below runs.
		const decodedText = decodeBracketedPasteCsiU(cappedText);

		// Clean the pasted text: normalize line endings, expand tabs
		const cleanText = this.normalizeText(decodedText);

		// Strip control chars except newline (\n is kept; \r was already mapped to
		// \n by normalizeText). Regex mirrors the old split/filter/join (charCode
		// >= 32 kept, so 0x7F DEL stays) without materializing a 1-char-per-cell array.
		let filteredText = cleanText.replace(CONTROL_CHARS_EXCEPT_NEWLINE_RE, "");

		// If pasting a file path (starts with /, ~, or .) and the character before
		// the cursor is a word character, prepend a space for better readability
		if (/^[/~.]/.test(filteredText)) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const charBeforeCursor = this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
			if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
				filteredText = ` ${filteredText}`;
			}
		}

		// Split into lines to check for large paste
		const pastedLines = filteredText.split("\n");

		// Check if this is a large paste (> 10 lines or > 1000 characters)
		const totalChars = filteredText.length;
		if (pastedLines.length > 10 || totalChars > 1000) {
			// Store the paste and insert a marker
			this.pasteCounter++;
			const pasteId = this.pasteCounter;
			this.pastes.set(pasteId, filteredText);
			this.validPasteIdsCache = undefined;
			this.invalidateWrapCache();

			// Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
			const marker =
				pastedLines.length > 10
					? `[paste #${pasteId} +${pastedLines.length} lines]`
					: `[paste #${pasteId} ${totalChars} chars]`;
			this.insertTextAtCursorInternal(marker);
			return;
		}

		if (pastedLines.length === 1) {
			// Single line - insert atomically (do not trigger autocomplete during paste)
			this.insertTextAtCursorInternal(filteredText);
			return;
		}

		// Multi-line paste - use direct state manipulation
		this.insertTextAtCursorInternal(filteredText);
	}

	private addNewLine(): void {
		this.cancelAutocomplete();
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		this.pushUndoSnapshot();

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		const before = currentLine.slice(0, this.state.cursorCol);
		const after = currentLine.slice(this.state.cursorCol);

		// Split current line
		this.state.lines[this.state.cursorLine] = before;
		this.state.lines.splice(this.state.cursorLine + 1, 0, after);

		// Move cursor to start of new line
		this.state.cursorLine++;
		this.setCursorCol(0);

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private shouldSubmitOnBackslashEnter(data: string, kb: ReturnType<typeof getKeybindings>): boolean {
		if (this.disableSubmit) return false;
		if (!matchesKey(data, "enter")) return false;
		const submitKeys = kb.getKeys("tui.input.submit");
		const hasShiftEnter = submitKeys.includes("shift+enter") || submitKeys.includes("shift+return");
		if (!hasShiftEnter) return false;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		return this.state.cursorCol > 0 && currentLine[this.state.cursorCol - 1] === "\\";
	}

	private submitValue(): void {
		this.cancelAutocomplete();
		const result = this.expandPasteMarkers(this.state.lines.join("\n")).trim();

		this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
		this.pastes.clear();
		this.validPasteIdsCache = undefined;
		this.invalidateWrapCache();
		this.pasteCounter = 0;
		this.historyIndex = -1;
		this.scrollOffset = 0;
		this.undoStack.clear();
		this.redoStack.clear();
		this.lastAction = null;

		if (this.onChange) this.onChange("");
		if (this.onSubmit) this.onSubmit(result);
	}

	private handleBackspace(): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Delete grapheme before cursor (handles emojis, combining characters, etc.)
			const line = this.state.lines[this.state.cursorLine] || "";
			const beforeCursor = line.slice(0, this.state.cursorCol);

			// Find the last grapheme in the text before cursor. Iterating keeps only
			// the final cluster instead of materializing every grapheme before the
			// cursor into an array on each backspace.
			let lastSegment: string | undefined;
			for (const grapheme of this.segment(beforeCursor)) {
				lastSegment = grapheme.segment;
			}
			const graphemeLength = lastSegment ? lastSegment.length : 1;

			const before = line.slice(0, this.state.cursorCol - graphemeLength);
			const after = line.slice(this.state.cursorCol);

			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - graphemeLength);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// Merge with previous line
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);

			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after backspace
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			// If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// Symbol-based completion context like @ or #
			else if (textBeforeCursor.match(/(?:^|[\s])[@#][^\s]*$/)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Set cursor column and clear preferredVisualCol.
	 * Use this for all non-vertical cursor movements to reset sticky column behavior.
	 */
	private setCursorCol(col: number): void {
		this.state.cursorCol = col;
		this.preferredVisualCol = null;
		this.snappedFromCursorCol = null;
	}

	/**
	 * Move cursor to a target visual line, applying sticky column logic.
	 * Shared by moveCursor() and pageScroll().
	 */
	private moveToVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		currentVisualLine: number,
		targetVisualLine: number,
	): void {
		const currentVL = visualLines[currentVisualLine];
		const targetVL = visualLines[targetVisualLine];
		if (!(currentVL && targetVL)) return;

		// When the cursor was snapped to a segment start, resolve the pre-snap
		// position against the VL it belongs to. This gives the correct visual
		// column even after a resize reshuffles VLs.
		let currentVisualCol: number;
		if (this.snappedFromCursorCol !== null) {
			const vlIndex = this.findVisualLineAt(visualLines, currentVL.logicalLine, this.snappedFromCursorCol);
			currentVisualCol = this.snappedFromCursorCol - visualLines[vlIndex].startCol;
		} else {
			currentVisualCol = this.state.cursorCol - currentVL.startCol;
		}

		// For non-last segments, clamp to length-1 to stay within the segment
		const isLastSourceSegment =
			currentVisualLine === visualLines.length - 1 ||
			visualLines[currentVisualLine + 1]?.logicalLine !== currentVL.logicalLine;
		const sourceMaxVisualCol = isLastSourceSegment ? currentVL.length : Math.max(0, currentVL.length - 1);

		const isLastTargetSegment =
			targetVisualLine === visualLines.length - 1 ||
			visualLines[targetVisualLine + 1]?.logicalLine !== targetVL.logicalLine;
		const targetMaxVisualCol = isLastTargetSegment ? targetVL.length : Math.max(0, targetVL.length - 1);

		const moveToVisualCol = this.computeVerticalMoveColumn(currentVisualCol, sourceMaxVisualCol, targetMaxVisualCol);

		// Set cursor position
		this.state.cursorLine = targetVL.logicalLine;
		const targetCol = targetVL.startCol + moveToVisualCol;
		const logicalLine = this.state.lines[targetVL.logicalLine] || "";
		this.state.cursorCol = Math.min(targetCol, logicalLine.length);

		// Snap cursor to atomic segment boundary (e.g. paste markers)
		// so the cursor never lands in the middle of a multi-grapheme unit.
		// Single-grapheme segments don't need snapping.
		const segments = [...this.segment(logicalLine)];
		for (const seg of segments) {
			if (seg.index > this.state.cursorCol) break;
			if (seg.segment.length <= 1) continue;
			if (this.state.cursorCol < seg.index + seg.segment.length) {
				const isContinuation = seg.index < targetVL.startCol;
				const isMovingDown = targetVisualLine > currentVisualLine;

				if (isContinuation && isMovingDown) {
					// The segment started on a previous visual line, and we
					// already visited it on the way down. Skip all remaining
					// continuation VLs and land on the first VL past it.
					const segEnd = seg.index + seg.segment.length;
					let next = targetVisualLine + 1;
					while (
						next < visualLines.length &&
						visualLines[next].logicalLine === targetVL.logicalLine &&
						visualLines[next].startCol < segEnd
					) {
						next++;
					}
					if (next < visualLines.length) {
						this.moveToVisualLine(visualLines, currentVisualLine, next);
						return;
					}
				}

				// Snap to the start of the segment so it gets highlighted.
				// Store the pre-snap position so the next vertical move can
				// resolve it to the correct visual column.
				this.snappedFromCursorCol = this.state.cursorCol;
				this.state.cursorCol = seg.index;
				return;
			}
		}

		// No snap occurred – we moved out of the atomic segment.
		this.snappedFromCursorCol = null;
	}

	/**
	 * Compute the target visual column for vertical cursor movement.
	 * Implements the sticky column decision table:
	 *
	 * | P | S | T | U | Scenario                                             | Set Preferred | Move To     |
	 * |---|---|---|---| ---------------------------------------------------- |---------------|-------------|
	 * | 0 | * | 0 | - | Start nav, target fits                               | null          | current     |
	 * | 0 | * | 1 | - | Start nav, target shorter                            | current       | target end  |
	 * | 1 | 0 | 0 | 0 | Clamped, target fits preferred                       | null          | preferred   |
	 * | 1 | 0 | 0 | 1 | Clamped, target longer but still can't fit preferred | keep          | target end  |
	 * | 1 | 0 | 1 | - | Clamped, target even shorter                         | keep          | target end  |
	 * | 1 | 1 | 0 | - | Rewrapped, target fits current                       | null          | current     |
	 * | 1 | 1 | 1 | - | Rewrapped, target shorter than current               | current       | target end  |
	 *
	 * Where:
	 * - P = preferred col is set
	 * - S = cursor in middle of source line (not clamped to end)
	 * - T = target line shorter than current visual col
	 * - U = target line shorter than preferred col
	 */
	private computeVerticalMoveColumn(
		currentVisualCol: number,
		sourceMaxVisualCol: number,
		targetMaxVisualCol: number,
	): number {
		const hasPreferred = this.preferredVisualCol !== null; // P
		const cursorInMiddle = currentVisualCol < sourceMaxVisualCol; // S
		const targetTooShort = targetMaxVisualCol < currentVisualCol; // T

		if (!hasPreferred || cursorInMiddle) {
			if (targetTooShort) {
				// Cases 2 and 7
				this.preferredVisualCol = currentVisualCol;
				return targetMaxVisualCol;
			}

			// Cases 1 and 6
			this.preferredVisualCol = null;
			return currentVisualCol;
		}

		const targetCantFitPreferred = targetMaxVisualCol < this.preferredVisualCol!; // U
		if (targetTooShort || targetCantFitPreferred) {
			// Cases 4 and 5
			return targetMaxVisualCol;
		}

		// Case 3
		const result = this.preferredVisualCol!;
		this.preferredVisualCol = null;
		return result;
	}

	private moveToLineStart(): void {
		this.lastAction = null;
		this.setCursorCol(0);
	}

	private moveToLineEnd(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		this.setCursorCol(currentLine.length);
	}

	private deleteToStartOfLine(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol > 0) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (backward deletion = prepend)
			const deletedText = currentLine.slice(0, this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// Delete from start of line up to cursor
			this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
			this.setCursorCol(0);
		} else if (this.state.cursorLine > 0) {
			this.pushUndoSnapshot();

			// At start of line - merge with previous line, treating newline as deleted text
			this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
			this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
			this.state.lines.splice(this.state.cursorLine, 1);
			this.state.cursorLine--;
			this.setCursorCol(previousLine.length);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteToEndOfLine(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Calculate text to be deleted and save to kill ring (forward deletion = append)
			const deletedText = currentLine.slice(this.state.cursorCol);
			this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			// Delete from cursor to end of line
			this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line, treating newline as deleted text
			this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
			this.lastAction = "kill";

			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordBackwards(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, behave like backspace at column 0 (merge with previous line)
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (backward deletion = prepend)
				this.killRing.push("\n", { prepend: true, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
				this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
				this.state.lines.splice(this.state.cursorLine, 1);
				this.state.cursorLine--;
				this.setCursorCol(previousLine.length);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before deletion (kill accumulation)
			const wasKill = this.lastAction === "kill";

			const { deletedText, newText, newCol, prepend } = computeWordDeletion(
				currentLine,
				this.state.cursorCol,
				"backward",
				(text) => this.segment(text),
				isPasteMarker,
			);
			this.killRing.push(deletedText, { prepend, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] = newText;
			this.setCursorCol(newCol);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private deleteWordForward(): void {
		this.historyIndex = -1; // Exit history browsing mode

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, merge with next line (delete the newline)
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.pushUndoSnapshot();

				// Treat newline as deleted text (forward deletion = append)
				this.killRing.push("\n", { prepend: false, accumulate: this.lastAction === "kill" });
				this.lastAction = "kill";

				const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
				this.state.lines[this.state.cursorLine] = currentLine + nextLine;
				this.state.lines.splice(this.state.cursorLine + 1, 1);
			}
		} else {
			this.pushUndoSnapshot();

			// Save lastAction before deletion (kill accumulation)
			const wasKill = this.lastAction === "kill";

			const { deletedText, newText, newCol, prepend } = computeWordDeletion(
				currentLine,
				this.state.cursorCol,
				"forward",
				(text) => this.segment(text),
				isPasteMarker,
			);
			this.killRing.push(deletedText, { prepend, accumulate: wasKill });
			this.lastAction = "kill";

			this.state.lines[this.state.cursorLine] = newText;
			// newCol === cursorCol (forward delete leaves the cursor put); the call
			// still resets the sticky visual column, matching the original flow.
			this.setCursorCol(newCol);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private handleForwardDelete(): void {
		this.historyIndex = -1; // Exit history browsing mode
		this.lastAction = null;

		const currentLine = this.state.lines[this.state.cursorLine] || "";

		if (this.state.cursorCol < currentLine.length) {
			this.pushUndoSnapshot();

			// Delete grapheme at cursor position (handles emojis, combining characters, etc.)
			const afterCursor = currentLine.slice(this.state.cursorCol);

			// Find the first grapheme at cursor
			// Iterator avoids materializing every grapheme to the right of the
			// cursor; only the first cluster is needed.
			const firstGrapheme = this.segment(afterCursor)[Symbol.iterator]().next().value;
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol + graphemeLength);
			this.state.lines[this.state.cursorLine] = before + after;
		} else if (this.state.cursorLine < this.state.lines.length - 1) {
			this.pushUndoSnapshot();

			// At end of line - merge with next line
			const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
			this.state.lines[this.state.cursorLine] = currentLine + nextLine;
			this.state.lines.splice(this.state.cursorLine + 1, 1);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}

		// Update or re-trigger autocomplete after forward delete
		if (this.autocompleteState) {
			this.updateAutocomplete();
		} else {
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
			// Slash command context
			if (this.isInSlashCommandContext(textBeforeCursor)) {
				this.tryTriggerAutocomplete();
			}
			// Symbol-based completion context like @ or #
			else if (textBeforeCursor.match(/(?:^|[\s])[@#][^\s]*$/)) {
				this.tryTriggerAutocomplete();
			}
		}
	}

	/**
	 * Build a mapping from visual lines to logical positions.
	 * Returns an array where each element represents a visual line with:
	 * - logicalLine: index into this.state.lines
	 * - startCol: starting column in the logical line
	 * - length: length of this visual line segment
	 *
	 * Memoized by (bufferRevision, width): the map never depends on cursor
	 * position, so ↑/↓/PageUp/PageDown (which call this on every keystroke)
	 * reuse the cached map instead of re-wrapping every logical line. Callers
	 * only read the returned array, never mutate it.
	 */
	private buildVisualLineMap(width: number): Array<{ logicalLine: number; startCol: number; length: number }> {
		if (
			this.visualLineMapCache &&
			this.visualLineMapWidth === width &&
			this.visualLineMapRevision === this.bufferRevision
		) {
			return this.visualLineMapCache;
		}

		const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

		for (let i = 0; i < this.state.lines.length; i++) {
			const line = this.state.lines[i] || "";
			const lineVisWidth = visibleWidth(line);
			if (line.length === 0) {
				// Empty line still takes one visual line
				visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
			} else if (lineVisWidth <= width) {
				visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
			} else {
				// Line needs wrapping - use word-aware wrapping
				const chunks = this.wrapLineCached(line, width);
				for (const chunk of chunks) {
					visualLines.push({
						logicalLine: i,
						startCol: chunk.startIndex,
						length: chunk.endIndex - chunk.startIndex,
					});
				}
			}
		}

		this.visualLineMapCache = visualLines;
		this.visualLineMapWidth = width;
		this.visualLineMapRevision = this.bufferRevision;
		return visualLines;
	}

	/**
	 * Find the visual line index that contains the given logical position.
	 */
	private findVisualLineAt(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
		line: number,
		col: number,
	): number {
		// visualLines is built in logical-line order (buildVisualLineMap loops
		// over state.lines ascending), so it is sorted by logicalLine. Binary
		// search to the first segment of `line` instead of scanning the whole
		// map on every cursor move: O(log V + k) vs O(V), where k = wrapped
		// segments of the current logical line.
		let lo = 0;
		let hi = visualLines.length - 1;
		let start = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			const ll = visualLines[mid]!.logicalLine;
			if (ll < line) {
				lo = mid + 1;
			} else if (ll > line) {
				hi = mid - 1;
			} else {
				start = mid;
				hi = mid - 1;
			}
		}
		if (start === -1) return visualLines.length - 1;
		for (let i = start; i < visualLines.length && visualLines[i]!.logicalLine === line; i++) {
			const vl = visualLines[i]!;
			const offset = col - vl.startCol;
			// Cursor is in this segment if it's within range. For the last
			// segment of a logical line, cursor can be at length (end position)
			const isLastSegmentOfLine = i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;
			if (offset >= 0 && (offset < vl.length || (isLastSegmentOfLine && offset === vl.length))) {
				return i;
			}
		}
		return visualLines.length - 1;
	}

	/**
	 * Find the visual line index for the current cursor position.
	 */
	private findCurrentVisualLine(
		visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
	): number {
		return this.findVisualLineAt(visualLines, this.state.cursorLine, this.state.cursorCol);
	}

	private moveCursor(
		deltaLine: number,
		deltaCol: number,
		precomputedVisualLines?: Array<{ logicalLine: number; startCol: number; length: number }>,
	): void {
		this.lastAction = null;

		// Up/down navigation needs the full visual-line map. Left/right only needs
		// it for the rare "at end of last line" preferred-column update, so build it
		// lazily there to avoid re-wrapping every logical line on each ←/→ keystroke.
		if (deltaLine !== 0) {
			const visualLines = precomputedVisualLines ?? this.buildVisualLineMap(this.lastWidth);
			const currentVisualLine = this.findCurrentVisualLine(visualLines);
			const targetVisualLine = currentVisualLine + deltaLine;

			if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
				this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
			}
		}

		if (deltaCol !== 0) {
			const currentLine = this.state.lines[this.state.cursorLine] || "";

			if (deltaCol > 0) {
				// Moving right - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.state.cursorCol < currentLine.length) {
					const afterCursor = currentLine.slice(this.state.cursorCol);
					// Iterator avoids materializing every grapheme to the right of the
					// cursor; only the first cluster is needed to advance one grapheme.
					const firstGrapheme = this.segment(afterCursor)[Symbol.iterator]().next().value;
					this.setCursorCol(this.state.cursorCol + (firstGrapheme ? firstGrapheme.segment.length : 1));
				} else if (this.state.cursorLine < this.state.lines.length - 1) {
					// Wrap to start of next logical line
					this.state.cursorLine++;
					this.setCursorCol(0);
				} else {
					// At end of last line - can't move, but set preferredVisualCol for up/down navigation
					const visualLines = precomputedVisualLines ?? this.buildVisualLineMap(this.lastWidth);
					const currentVL = visualLines[this.findCurrentVisualLine(visualLines)];
					if (currentVL) {
						this.preferredVisualCol = this.state.cursorCol - currentVL.startCol;
					}
				}
			} else {
				// Moving left - move by one grapheme (handles emojis, combining characters, etc.)
				if (this.state.cursorCol > 0) {
					const beforeCursor = currentLine.slice(0, this.state.cursorCol);
					// Iterate to the last grapheme instead of materializing every
					// grapheme before the cursor into an array on each left move.
					let lastSegment: string | undefined;
					for (const g of this.segment(beforeCursor)) lastSegment = g.segment;
					this.setCursorCol(this.state.cursorCol - (lastSegment ? lastSegment.length : 1));
				} else if (this.state.cursorLine > 0) {
					// Wrap to end of previous logical line
					this.state.cursorLine--;
					const prevLine = this.state.lines[this.state.cursorLine] || "";
					this.setCursorCol(prevLine.length);
				}
			}
		}
	}

	/**
	 * Scroll by a page (direction: -1 for up, 1 for down).
	 * Moves cursor by the page size while keeping it in bounds.
	 */
	private pageScroll(direction: -1 | 1): void {
		this.lastAction = null;
		const terminalRows = this.tui.terminal.rows;
		const pageSize = Math.max(5, Math.floor(terminalRows * 0.3));

		const visualLines = this.buildVisualLineMap(this.lastWidth);
		const currentVisualLine = this.findCurrentVisualLine(visualLines);
		const targetVisualLine = Math.max(0, Math.min(visualLines.length - 1, currentVisualLine + direction * pageSize));

		this.moveToVisualLine(visualLines, currentVisualLine, targetVisualLine);
	}

	private moveWordBackwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at start of line, move to end of previous line
		if (this.state.cursorCol === 0) {
			if (this.state.cursorLine > 0) {
				this.state.cursorLine--;
				const prevLine = this.state.lines[this.state.cursorLine] || "";
				this.setCursorCol(prevLine.length);
			}
			return;
		}

		const graphemes = [...this.segment(currentLine.slice(0, this.state.cursorCol))];
		this.setCursorCol(computeWordMoveColumn(graphemes, this.state.cursorCol, "backward", isPasteMarker));
	}

	/**
	 * Yank (paste) the most recent kill ring entry at cursor position.
	 */
	private yank(): void {
		if (this.killRing.length === 0) return;

		this.pushUndoSnapshot();

		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Cycle through kill ring (only works immediately after yank or yank-pop).
	 * Replaces the last yanked text with the previous entry in the ring.
	 */
	private yankPop(): void {
		// Only works if we just yanked and have more than one entry
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndoSnapshot();

		// Delete the previously yanked text (still at end of ring before rotation)
		this.deleteYankedText();

		// Rotate the ring: move end to front
		this.killRing.rotate();

		// Insert the new most recent entry (now at end after rotation)
		const text = this.killRing.peek()!;
		this.insertYankedText(text);

		this.lastAction = "yank";
	}

	/**
	 * Insert text at cursor position (used by yank operations).
	 */
	private insertYankedText(text: string): void {
		this.historyIndex = -1; // Exit history browsing mode
		const lines = text.split("\n");

		if (lines.length === 1) {
			// Single line - insert at cursor
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + text + after;
			this.setCursorCol(this.state.cursorCol + text.length);
		} else {
			// Multi-line insert
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const before = currentLine.slice(0, this.state.cursorCol);
			const after = currentLine.slice(this.state.cursorCol);

			// First line merges with text before cursor
			this.state.lines[this.state.cursorLine] = before + (lines[0] || "");

			// Insert middle lines
			for (let i = 1; i < lines.length - 1; i++) {
				this.state.lines.splice(this.state.cursorLine + i, 0, lines[i] || "");
			}

			// Last line merges with text after cursor
			const lastLineIndex = this.state.cursorLine + lines.length - 1;
			this.state.lines.splice(lastLineIndex, 0, (lines[lines.length - 1] || "") + after);

			// Update cursor position
			this.state.cursorLine = lastLineIndex;
			this.setCursorCol((lines[lines.length - 1] || "").length);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Delete the previously yanked text (used by yank-pop).
	 * The yanked text is derived from killRing[end] since it hasn't been rotated yet.
	 */
	private deleteYankedText(): void {
		const yankedText = this.killRing.peek();
		if (!yankedText) return;

		const yankLines = yankedText.split("\n");

		if (yankLines.length === 1) {
			// Single line - delete backward from cursor
			const currentLine = this.state.lines[this.state.cursorLine] || "";
			const deleteLen = yankedText.length;
			const before = currentLine.slice(0, this.state.cursorCol - deleteLen);
			const after = currentLine.slice(this.state.cursorCol);
			this.state.lines[this.state.cursorLine] = before + after;
			this.setCursorCol(this.state.cursorCol - deleteLen);
		} else {
			// Multi-line delete - cursor is at end of last yanked line
			const startLine = this.state.cursorLine - (yankLines.length - 1);
			const startCol = (this.state.lines[startLine] || "").length - (yankLines[0] || "").length;

			// Get text after cursor on current line
			const afterCursor = (this.state.lines[this.state.cursorLine] || "").slice(this.state.cursorCol);

			// Get text before yank start position
			const beforeYank = (this.state.lines[startLine] || "").slice(0, startCol);

			// Remove all lines from startLine to cursorLine and replace with merged line
			this.state.lines.splice(startLine, yankLines.length, beforeYank + afterCursor);

			// Update cursor
			this.state.cursorLine = startLine;
			this.setCursorCol(startCol);
		}

		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private pushUndoSnapshot(): void {
		this.undoStack.push(this.state);
		// A new edit invalidates the redo future. undo()/redo() set this flag so
		// their own snapshot bookkeeping doesn't trip the clear.
		if (!this.applyingHistory) {
			this.redoStack.clear();
		}
	}

	private undo(): void {
		this.historyIndex = -1; // Exit history browsing mode
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		// Push the current (pre-undo) state onto the redo stack before applying.
		this.applyingHistory = true;
		this.redoStack.push(this.state);
		this.applyingHistory = false;
		Object.assign(this.state, snapshot);
		this.lastAction = null;
		this.preferredVisualCol = null;
		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	private redo(): void {
		this.historyIndex = -1; // Exit history browsing mode
		const snapshot = this.redoStack.pop();
		if (!snapshot) return;
		// Push the current state onto the undo stack so redo is itself undoable,
		// without clearing the redo stack (applyingHistory guards pushUndoSnapshot).
		this.applyingHistory = true;
		this.pushUndoSnapshot();
		this.applyingHistory = false;
		Object.assign(this.state, snapshot);
		this.lastAction = null;
		this.preferredVisualCol = null;
		this.touchBuffer();
		if (this.onChange) {
			this.onChange(this.getText());
		}
	}

	/**
	 * Jump to the first occurrence of a character in the specified direction.
	 * Multi-line search. Case-sensitive. Skips the current cursor position.
	 */
	private jumpToChar(char: string, direction: "forward" | "backward"): void {
		this.lastAction = null;
		const isForward = direction === "forward";
		const lines = this.state.lines;

		const end = isForward ? lines.length : -1;
		const step = isForward ? 1 : -1;

		for (let lineIdx = this.state.cursorLine; lineIdx !== end; lineIdx += step) {
			const line = lines[lineIdx] || "";
			const isCurrentLine = lineIdx === this.state.cursorLine;

			// Backward from column 0: nothing before the cursor on this line.
			// lastIndexOf(char, -1) treats -1 as 0 and would inspect index 0
			// (the cursor's own position), so skip the current line entirely.
			if (isCurrentLine && !isForward && this.state.cursorCol === 0) {
				continue;
			}

			// Current line: start after/before cursor; other lines: search full line
			const searchFrom = isCurrentLine
				? isForward
					? this.state.cursorCol + 1
					: this.state.cursorCol - 1
				: undefined;

			const idx = isForward ? line.indexOf(char, searchFrom) : line.lastIndexOf(char, searchFrom);

			if (idx !== -1) {
				this.state.cursorLine = lineIdx;
				this.setCursorCol(idx);
				return;
			}
		}
		// No match found - cursor stays in place
	}

	private moveWordForwards(): void {
		this.lastAction = null;
		const currentLine = this.state.lines[this.state.cursorLine] || "";

		// If at end of line, move to start of next line
		if (this.state.cursorCol >= currentLine.length) {
			if (this.state.cursorLine < this.state.lines.length - 1) {
				this.state.cursorLine++;
				this.setCursorCol(0);
			}
			return;
		}

		const graphemes = [...this.segment(currentLine.slice(this.state.cursorCol))];
		this.setCursorCol(computeWordMoveColumn(graphemes, this.state.cursorCol, "forward", isPasteMarker));
	}

	// Slash menu only allowed on the first line of the editor
	private isSlashMenuAllowed(): boolean {
		return this.state.cursorLine === 0;
	}

	// Helper method to check if cursor is at start of message (for slash command detection)
	private isAtStartOfMessage(): boolean {
		if (!this.isSlashMenuAllowed()) return false;
		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	}

	private isInSlashCommandContext(textBeforeCursor: string): boolean {
		return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
	}

	// Autocomplete methods
	/**
	 * Find the best autocomplete item index for the given prefix.
	 * Returns -1 if no match is found.
	 *
	 * Match priority:
	 * 1. Exact match (prefix === item.value) -> always selected
	 * 2. Prefix match -> first item whose value starts with prefix
	 * 3. No match -> -1 (keep default highlight)
	 *
	 * Matching is case-sensitive and checks item.value only.
	 */
	private getBestAutocompleteMatchIndex(items: Array<{ value: string; label: string }>, prefix: string): number {
		if (!prefix) return -1;

		let firstPrefixIndex = -1;

		for (let i = 0; i < items.length; i++) {
			const value = items[i]!.value;
			if (value === prefix) {
				return i; // Exact match always wins
			}
			if (firstPrefixIndex === -1 && value.startsWith(prefix)) {
				firstPrefixIndex = i;
			}
		}

		return firstPrefixIndex;
	}

	private createAutocompleteList(
		prefix: string,
		items: Array<{ value: string; label: string; description?: string }>,
	): SelectList {
		// Enable the trailing key hint so the dropdown spells out how to accept /
		// navigate / dismiss. The slash-command layout keeps its column sizing; the
		// hint is layered on top of whichever base layout applies.
		const baseLayout: SelectListLayoutOptions = prefix.startsWith("/") ? SLASH_COMMAND_SELECT_LIST_LAYOUT : {};
		const layout: SelectListLayoutOptions = { ...baseLayout, showKeyHints: true };
		return new SelectList(items, this.autocompleteMaxVisible, this.theme.selectList, layout);
	}

	private tryTriggerAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: false, explicitTab });
	}

	private handleTabCompletion(): void {
		if (!this.autocompleteProvider) return;

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol);

		if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
			this.handleSlashCommandCompletion();
		} else {
			this.forceFileAutocomplete(true);
		}
	}

	private handleSlashCommandCompletion(): void {
		this.requestAutocomplete({ force: false, explicitTab: true });
	}

	private forceFileAutocomplete(explicitTab: boolean = false): void {
		this.requestAutocomplete({ force: true, explicitTab });
	}

	private requestAutocomplete(options: { force: boolean; explicitTab: boolean }): void {
		if (!this.autocompleteProvider) return;

		if (options.force) {
			const shouldTrigger =
				!this.autocompleteProvider.shouldTriggerFileCompletion ||
				this.autocompleteProvider.shouldTriggerFileCompletion(
					this.state.lines,
					this.state.cursorLine,
					this.state.cursorCol,
				);
			if (!shouldTrigger) {
				return;
			}
		}

		this.cancelAutocompleteRequest();
		const startToken = ++this.autocompleteStartToken;

		const debounceMs = this.getAutocompleteDebounceMs(options);
		if (debounceMs > 0) {
			this.autocompleteDebounceTimer = setTimeout(() => {
				this.autocompleteDebounceTimer = undefined;
				void this.startAutocompleteRequest(startToken, options);
			}, debounceMs);
			return;
		}

		void this.startAutocompleteRequest(startToken, options);
	}

	private async startAutocompleteRequest(
		startToken: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		const previousTask = this.autocompleteRequestTask;
		this.autocompleteRequestTask = (async () => {
			// Bound the wait on the predecessor: a hung prior request (provider Promise
			// that never settles) must not wedge the serialized chain forever. On
			// timeout we drop through; staleness is re-checked via the start token below.
			await withTimeout(previousTask, autocompleteTimeoutMs());
			if (startToken !== this.autocompleteStartToken || !this.autocompleteProvider) {
				return;
			}

			const controller = new AbortController();
			this.autocompleteAbort = controller;
			const requestId = ++this.autocompleteRequestId;
			const snapshotText = this.getText();
			const snapshotLine = this.state.cursorLine;
			const snapshotCol = this.state.cursorCol;

			await this.runAutocompleteRequest(requestId, controller, snapshotText, snapshotLine, snapshotCol, options);
		})();
		await this.autocompleteRequestTask;
	}

	private getAutocompleteDebounceMs(options: { force: boolean; explicitTab: boolean }): number {
		if (options.explicitTab || options.force) {
			return 0;
		}

		const currentLine = this.state.lines[this.state.cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
		const isSymbolAutocompleteContext = /(?:^|[ \t])(?:@(?:"[^"]*|[^\s]*)|#[^\s]*)$/.test(textBeforeCursor);
		if (isSymbolAutocompleteContext) {
			return ATTACHMENT_AUTOCOMPLETE_DEBOUNCE_MS;
		}
		const isSlashContext = /(?:^|\s)\/[^\s]*$/.test(textBeforeCursor);
		const isPathContext = /(?:^|\s)(?:~\/|\.\/|\.\.\/|\/|(?:[A-Za-z]:)?[\\/])[^\s]*$/.test(textBeforeCursor);
		if (isSlashContext || isPathContext) {
			return DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS;
		}
		return DEFAULT_AUTOCOMPLETE_DEBOUNCE_MS;
	}

	private async runAutocompleteRequest(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
		options: { force: boolean; explicitTab: boolean },
	): Promise<void> {
		if (!this.autocompleteProvider) return;

		try {
			// Bound the provider call: if it hangs (Promise that never settles), abandon
			// this request after the timeout instead of pinning the serialized chain.
			// withTimeout yields undefined on timeout — distinct from a provider that
			// resolves with no items — so we abort and bail without touching the UI.
			const providerPromise = this.autocompleteProvider.getSuggestions(
				this.state.lines,
				this.state.cursorLine,
				this.state.cursorCol,
				{ signal: controller.signal, force: options.force },
			);
			const settled = await withTimeout(
				providerPromise.then((value) => ({ value }) as const),
				autocompleteTimeoutMs(),
			);
			if (settled === undefined) {
				// Timed out: signal the (still-pending) provider to abort and stop here.
				controller.abort();
				if (this.autocompleteAbort === controller) this.autocompleteAbort = undefined;
				return;
			}
			const suggestions = settled.value;

			if (!this.isAutocompleteRequestCurrent(requestId, controller, snapshotText, snapshotLine, snapshotCol)) {
				return;
			}

			this.autocompleteAbort = undefined;

			if (!suggestions || !Array.isArray(suggestions.items) || suggestions.items.length === 0) {
				this.cancelAutocomplete();
				this.tui.requestRender();
				return;
			}

			if (options.force && options.explicitTab && suggestions.items.length === 1) {
				const item = suggestions.items[0]!;
				this.pushUndoSnapshot();
				this.lastAction = null;
				const result = this.autocompleteProvider.applyCompletion(
					this.state.lines,
					this.state.cursorLine,
					this.state.cursorCol,
					item,
					suggestions.prefix,
				);
				this.state.lines = result.lines;
				this.state.cursorLine = result.cursorLine;
				this.setCursorCol(result.cursorCol);
				this.touchBuffer();
				if (this.onChange) this.onChange(this.getText());
				this.tui.requestRender();
				return;
			}

			this.applyAutocompleteSuggestions(suggestions, options.force ? "force" : "regular");
			this.tui.requestRender();
		} catch {
			controller.abort();
			if (this.autocompleteAbort === controller) this.autocompleteAbort = undefined;
			this.cancelAutocomplete();
			this.tui.requestRender();
		}
	}

	private isAutocompleteRequestCurrent(
		requestId: number,
		controller: AbortController,
		snapshotText: string,
		snapshotLine: number,
		snapshotCol: number,
	): boolean {
		return (
			!controller.signal.aborted &&
			requestId === this.autocompleteRequestId &&
			this.getText() === snapshotText &&
			this.state.cursorLine === snapshotLine &&
			this.state.cursorCol === snapshotCol
		);
	}

	private applyAutocompleteSuggestions(suggestions: AutocompleteSuggestions, state: "regular" | "force"): void {
		this.autocompletePrefix = suggestions.prefix;
		this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

		const bestMatchIndex = this.getBestAutocompleteMatchIndex(suggestions.items, suggestions.prefix);
		if (bestMatchIndex >= 0) {
			this.autocompleteList.setSelectedIndex(bestMatchIndex);
		}

		this.autocompleteState = state;
	}

	private cancelAutocompleteRequest(): void {
		this.autocompleteStartToken += 1;
		if (this.autocompleteDebounceTimer) {
			clearTimeout(this.autocompleteDebounceTimer);
			this.autocompleteDebounceTimer = undefined;
		}
		this.autocompleteAbort?.abort();
		this.autocompleteAbort = undefined;
	}

	private clearAutocompleteUi(): void {
		this.autocompleteState = null;
		this.autocompleteList = undefined;
		this.autocompletePrefix = "";
	}

	private cancelAutocomplete(): void {
		this.cancelAutocompleteRequest();
		this.clearAutocompleteUi();
	}

	public isShowingAutocomplete(): boolean {
		return this.autocompleteState !== null;
	}

	private updateAutocomplete(): void {
		if (!this.autocompleteState || !this.autocompleteProvider) return;
		this.requestAutocomplete({ force: this.autocompleteState === "force", explicitTab: false });
	}

	// =========================================================================
	// Reverse history search (Ctrl+R)
	// =========================================================================

	/** True while the reverse-history-search overlay is open. */
	public isShowingHistorySearch(): boolean {
		return this.historySearchList !== null;
	}

	/** Build SelectItems from history: full prompt in `value` (injected on
	 * confirm), single-lined preview in `label` (shown in the list). */
	private buildHistorySearchItems(): SelectItem[] {
		return this.history.map((entry) => ({
			value: entry,
			// Collapse newlines/whitespace so multi-line prompts show as one row.
			label: entry.replace(/\s+/g, " ").trim(),
		}));
	}

	private openHistorySearch(): void {
		if (this.history.length === 0) return;
		// Don't fight the autocomplete overlay; close it first.
		this.cancelAutocomplete();
		this.historySearchQuery = "";
		const list = new SelectList(this.buildHistorySearchItems(), this.autocompleteMaxVisible, this.theme.selectList, {
			showKeyHints: true,
		});
		this.historySearchList = list;
		this.tui.requestRender();
	}

	private closeHistorySearch(): void {
		if (this.historySearchDebounceTimer !== undefined) {
			clearTimeout(this.historySearchDebounceTimer);
			this.historySearchDebounceTimer = undefined;
		}
		this.historySearchList = null;
		this.historySearchQuery = "";
	}

	private scheduleHistorySearchFilter(): void {
		if (this.historySearchDebounceTimer !== undefined) {
			clearTimeout(this.historySearchDebounceTimer);
		}
		this.historySearchDebounceTimer = setTimeout(() => {
			this.historySearchDebounceTimer = undefined;
			const list = this.historySearchList;
			if (!list) return;
			list.setFilter(this.historySearchQuery);
			this.tui.requestRender();
		}, HISTORY_SEARCH_DEBOUNCE_MS);
	}

	private applyHistorySearchSelection(item: SelectItem): void {
		this.closeHistorySearch();
		// Inject the chosen prompt as a normal programmatic setText (undoable,
		// exits history-browsing). Cursor lands at the end via setTextInternal.
		this.setText(item.value);
	}

	private handleHistorySearchInput(data: string, kb: ReturnType<typeof getKeybindings>): void {
		const list = this.historySearchList;
		if (!list) return;

		// Esc / Ctrl+C close without changing the buffer.
		if (kb.matches(data, "tui.select.cancel")) {
			this.closeHistorySearch();
			return;
		}

		// Ctrl+R again steps the selection (classic reverse-search cadence).
		if (kb.matches(data, "tui.editor.historySearch") || kb.matches(data, "tui.select.up")) {
			list.handleInput(data === "\x12" ? "\x1b[A" : data);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			list.handleInput(data);
			return;
		}

		// Enter injects the highlighted prompt.
		if (kb.matches(data, "tui.select.confirm")) {
			const selected = list.getSelectedItem();
			if (selected) this.applyHistorySearchSelection(selected);
			else this.closeHistorySearch();
			return;
		}

		// Backspace narrows/widens the query.
		if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "shift+backspace")) {
			this.historySearchQuery = this.historySearchQuery.slice(0, -1);
			this.scheduleHistorySearchFilter();
			return;
		}

		// Printable input extends the incremental query.
		const printable = decodePrintableKey(data) ?? (data.length === 1 && data.charCodeAt(0) >= 32 ? data : undefined);
		if (printable !== undefined) {
			this.historySearchQuery += printable;
			this.scheduleHistorySearchFilter();
		}
		// Any other control key is swallowed while the overlay is open.
	}
}
