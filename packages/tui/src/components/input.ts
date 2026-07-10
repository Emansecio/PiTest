import { getKeybindings } from "../keybindings.ts";
import { decodeKittyPrintable } from "../keys.ts";
import { KillRing } from "../kill-ring.ts";
import { computeWordDeletion, computeWordMoveColumn, decodeBracketedPasteCsiU } from "../text-edit-core.ts";
import { type Component, CURSOR_MARKER, type Focusable } from "../tui.ts";
import { UndoStack } from "../undo-stack.ts";
import { getSegmenter, isWhitespaceChar, sliceByColumn, truncateToWidth, visibleWidth } from "../utils.ts";

const segmenter = getSegmenter();

// Strip all control chars (0x00-0x1F) from a paste. Applied after tabs are
// expanded to spaces; mirrors the old `charCode >= 32` filter without
// materializing a 1-char-per-cell array.
const CONTROL_CHARS_RE = /[\x00-\x1f]/g;
// Hard cap on a single paste (10 MiB) applied before any full-string pass, so a
// huge blob can't freeze the event loop or OOM.
const MAX_PASTE_BYTES = 10 * 1024 * 1024;

interface InputState {
	value: string;
	cursor: number;
}

export interface InputOptions {
	/**
	 * Called when a paste exceeds MAX_PASTE_BYTES and is truncated. Input has no
	 * warning surface of its own, so the consumer plumbs this to its own warning
	 * mechanism. `originalBytes` is the pre-truncation length, `keptBytes` the
	 * length actually inserted.
	 */
	onPasteTruncated?: (info: { originalBytes: number; keptBytes: number }) => void;
	/**
	 * Optional dim hint shown when the field is empty (behind the cursor).
	 * Cleared as soon as the value is non-empty.
	 */
	placeholder?: string;
	/** Color for the empty-field placeholder (defaults to identity / terminal fg). */
	placeholderColor?: (text: string) => string;
}

/**
 * Input component - single-line text input with horizontal scrolling
 */
export class Input implements Component, Focusable {
	private value: string = "";
	private cursor: number = 0; // Cursor position in the value
	public onSubmit?: (value: string) => void;
	public onEscape?: () => void;
	private onPasteTruncated?: (info: { originalBytes: number; keptBytes: number }) => void;
	private placeholder?: string;
	private placeholderColor?: (text: string) => string;

	constructor(options: InputOptions = {}) {
		this.onPasteTruncated = options.onPasteTruncated;
		this.placeholder = options.placeholder;
		this.placeholderColor = options.placeholderColor;
	}

	setPlaceholder(text?: string): void {
		this.placeholder = text;
	}

	getPlaceholder(): string | undefined {
		return this.placeholder;
	}

	/** Focusable interface - set by TUI when focus changes */
	focused: boolean = false;

	// Bracketed paste mode buffering
	private pasteBuffer: string = "";
	private isInPaste: boolean = false;

	// Kill ring for Emacs-style kill/yank operations
	private killRing = new KillRing();
	private lastAction: "kill" | "yank" | "type-word" | null = null;

	// Undo support
	private undoStack = new UndoStack<InputState>();

	getValue(): string {
		return this.value;
	}

	setValue(value: string): void {
		this.value = value;
		this.cursor = Math.min(this.cursor, value.length);
	}

	handleInput(data: string): void {
		// Handle bracketed paste mode
		// Start of paste: \x1b[200~
		// End of paste: \x1b[201~

		// Check if we're starting a bracketed paste
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		// If we're in a paste, buffer the data
		if (this.isInPaste) {
			// Check if this chunk contains the end marker. Search only from near
			// the previous tail: the end marker can't begin before
			// (prevLen - (marker.length - 1)) without having already been found on
			// a prior chunk, so re-scanning the whole accumulated buffer every
			// chunk (O(n^2) over a byte-at-a-time paste) is wasted work. Mirrors
			// the windowed search in stdin-buffer.ts.
			const prevLen = this.pasteBuffer.length;
			this.pasteBuffer += data;

			const searchFrom = Math.max(0, prevLen - 5); // "\x1b[201~".length - 1 = 5
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~", searchFrom);
			if (endIndex !== -1) {
				// Extract the pasted content
				const pasteContent = this.pasteBuffer.substring(0, endIndex);

				// Process the complete paste
				this.handlePaste(pasteContent);

				// Reset paste state
				this.isInPaste = false;

				// Handle any remaining input after the paste marker
				const remaining = this.pasteBuffer.substring(endIndex + 6); // 6 = length of \x1b[201~
				this.pasteBuffer = "";
				if (remaining) {
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

		const kb = getKeybindings();

		// Escape/Cancel
		if (kb.matches(data, "tui.select.cancel")) {
			if (this.onEscape) this.onEscape();
			return;
		}

		// Undo
		if (kb.matches(data, "tui.editor.undo")) {
			this.undo();
			return;
		}

		// Submit
		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			if (this.onSubmit) this.onSubmit(this.value);
			return;
		}

		// Deletion
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			this.handleBackspace();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			this.handleForwardDelete();
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

		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.deleteToLineStart();
			return;
		}

		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.deleteToLineEnd();
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

		// Cursor movement
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			this.lastAction = null;
			if (this.cursor > 0) {
				const beforeCursor = this.value.slice(0, this.cursor);
				const graphemes = [...segmenter.segment(beforeCursor)];
				const lastGrapheme = graphemes[graphemes.length - 1];
				this.cursor -= lastGrapheme ? lastGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorRight")) {
			this.lastAction = null;
			if (this.cursor < this.value.length) {
				const afterCursor = this.value.slice(this.cursor);
				const graphemes = [...segmenter.segment(afterCursor)];
				const firstGrapheme = graphemes[0];
				this.cursor += firstGrapheme ? firstGrapheme.segment.length : 1;
			}
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.lastAction = null;
			this.cursor = 0;
			return;
		}

		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.lastAction = null;
			this.cursor = this.value.length;
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

		// Kitty CSI-u printable character (e.g. \x1b[97u for 'a').
		// Terminals with Kitty protocol flag 1 (disambiguate) send CSI-u for all keys,
		// including plain printable characters. Decode before the control-char check
		// since CSI-u sequences contain \x1b which would be rejected.
		const kittyPrintable = decodeKittyPrintable(data);
		if (kittyPrintable !== undefined) {
			this.insertCharacter(kittyPrintable);
			return;
		}

		// Regular character input - accept printable characters including Unicode,
		// but reject control characters (C0: 0x00-0x1F, DEL: 0x7F, C1: 0x80-0x9F)
		const hasControlChars = [...data].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControlChars) {
			this.insertCharacter(data);
		}
	}

	private insertCharacter(char: string): void {
		// Undo coalescing: consecutive word chars coalesce into one undo unit
		if (isWhitespaceChar(char) || this.lastAction !== "type-word") {
			this.pushUndo();
		}
		this.lastAction = "type-word";

		this.value = this.value.slice(0, this.cursor) + char + this.value.slice(this.cursor);
		this.cursor += char.length;
	}

	private handleBackspace(): void {
		this.lastAction = null;
		if (this.cursor > 0) {
			this.pushUndo();
			const beforeCursor = this.value.slice(0, this.cursor);
			const graphemes = [...segmenter.segment(beforeCursor)];
			const lastGrapheme = graphemes[graphemes.length - 1];
			const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor - graphemeLength) + this.value.slice(this.cursor);
			this.cursor -= graphemeLength;
		}
	}

	private handleForwardDelete(): void {
		this.lastAction = null;
		if (this.cursor < this.value.length) {
			this.pushUndo();
			const afterCursor = this.value.slice(this.cursor);
			const graphemes = [...segmenter.segment(afterCursor)];
			const firstGrapheme = graphemes[0];
			const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;
			this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + graphemeLength);
		}
	}

	private deleteToLineStart(): void {
		if (this.cursor === 0) return;
		this.pushUndo();
		const deletedText = this.value.slice(0, this.cursor);
		this.killRing.push(deletedText, { prepend: true, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(this.cursor);
		this.cursor = 0;
	}

	private deleteToLineEnd(): void {
		if (this.cursor >= this.value.length) return;
		this.pushUndo();
		const deletedText = this.value.slice(this.cursor);
		this.killRing.push(deletedText, { prepend: false, accumulate: this.lastAction === "kill" });
		this.lastAction = "kill";
		this.value = this.value.slice(0, this.cursor);
	}

	private deleteWordBackwards(): void {
		if (this.cursor === 0) return;

		// Save lastAction before deletion (kill accumulation)
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const { deletedText, newText, newCol, prepend } = computeWordDeletion(
			this.value,
			this.cursor,
			"backward",
			(text) => segmenter.segment(text),
		);
		this.killRing.push(deletedText, { prepend, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = newText;
		this.cursor = newCol;
	}

	private deleteWordForward(): void {
		if (this.cursor >= this.value.length) return;

		// Save lastAction before deletion (kill accumulation)
		const wasKill = this.lastAction === "kill";

		this.pushUndo();

		const { deletedText, newText, newCol, prepend } = computeWordDeletion(
			this.value,
			this.cursor,
			"forward",
			(text) => segmenter.segment(text),
		);
		this.killRing.push(deletedText, { prepend, accumulate: wasKill });
		this.lastAction = "kill";

		this.value = newText;
		this.cursor = newCol;
	}

	private yank(): void {
		const text = this.killRing.peek();
		if (!text) return;

		this.pushUndo();

		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private yankPop(): void {
		if (this.lastAction !== "yank" || this.killRing.length <= 1) return;

		this.pushUndo();

		// Delete the previously yanked text (still at end of ring before rotation)
		const prevText = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor - prevText.length) + this.value.slice(this.cursor);
		this.cursor -= prevText.length;

		// Rotate and insert new entry
		this.killRing.rotate();
		const text = this.killRing.peek() || "";
		this.value = this.value.slice(0, this.cursor) + text + this.value.slice(this.cursor);
		this.cursor += text.length;
		this.lastAction = "yank";
	}

	private pushUndo(): void {
		this.undoStack.push({ value: this.value, cursor: this.cursor });
	}

	private undo(): void {
		const snapshot = this.undoStack.pop();
		if (!snapshot) return;
		this.value = snapshot.value;
		this.cursor = snapshot.cursor;
		this.lastAction = null;
	}

	private moveWordBackwards(): void {
		if (this.cursor === 0) {
			return;
		}

		this.lastAction = null;
		const graphemes = [...segmenter.segment(this.value.slice(0, this.cursor))];
		this.cursor = computeWordMoveColumn(graphemes, this.cursor, "backward");
	}

	private moveWordForwards(): void {
		if (this.cursor >= this.value.length) {
			return;
		}

		this.lastAction = null;
		const graphemes = [...segmenter.segment(this.value.slice(this.cursor))];
		this.cursor = computeWordMoveColumn(graphemes, this.cursor, "forward");
	}

	private handlePaste(pastedText: string): void {
		this.lastAction = null;
		this.pushUndo();

		// Cap the paste BEFORE any full-string pass so a multi-MB blob can't freeze
		// the event loop or OOM (the cleanup below is O(n) over the whole string).
		// Input has no warning surface; the consumer's onPasteTruncated surfaces it.
		const wasTruncated = pastedText.length > MAX_PASTE_BYTES;
		const cappedText = wasTruncated ? pastedText.slice(0, MAX_PASTE_BYTES) : pastedText;
		if (wasTruncated) {
			this.onPasteTruncated?.({ originalBytes: pastedText.length, keptBytes: cappedText.length });
		}

		// Decode CSI-u-encoded control bytes some terminals inject into pastes
		// (see decodeBracketedPasteCsiU) before the cleanup below strips them.
		const decodedText = decodeBracketedPasteCsiU(cappedText);

		// Clean the pasted text - expand tabs, then strip all control bytes
		// (charCode < 32, incl. newlines/carriage returns). Regex mirrors the old
		// split/filter/join (charCode >= 32 kept) without allocating a 1-char array.
		const cleanText = decodedText.replace(/\t/g, "    ").replace(CONTROL_CHARS_RE, "");

		// Insert at cursor position
		this.value = this.value.slice(0, this.cursor) + cleanText + this.value.slice(this.cursor);
		this.cursor += cleanText.length;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		// Calculate visible window
		const prompt = "> ";
		const availableWidth = width - prompt.length;

		if (availableWidth <= 0) {
			return [prompt];
		}

		// Empty-field placeholder: reverse-video space cursor, then full dim hint
		// (do not reverse the first letter of the placeholder — that looked like
		// the hint was sitting outside a one-character "box").
		if (this.value.length === 0 && this.placeholder) {
			const colorize = this.placeholderColor ?? ((t: string) => t);
			const marker = this.focused ? CURSOR_MARKER : "";
			const cursor = this.focused ? "\x1b[7m \x1b[27m" : " ";
			const hintBudget = Math.max(0, availableWidth - 1);
			const truncated = hintBudget > 0 ? truncateToWidth(this.placeholder, hintBudget, "…") : "";
			const body = marker + cursor + (truncated ? colorize(truncated) : "");
			const pad = " ".repeat(Math.max(0, availableWidth - (1 + visibleWidth(truncated))));
			return [`${prompt}${body}${pad}`];
		}

		let visibleText = "";
		let cursorDisplay = this.cursor;
		const totalWidth = visibleWidth(this.value);

		if (totalWidth < availableWidth) {
			// Everything fits (leave room for cursor at end)
			visibleText = this.value;
		} else {
			// Need horizontal scrolling
			// Reserve one column for cursor if it's at the end
			const scrollWidth = this.cursor === this.value.length ? availableWidth - 1 : availableWidth;
			const cursorCol = visibleWidth(this.value.slice(0, this.cursor));

			if (scrollWidth > 0) {
				const halfWidth = Math.floor(scrollWidth / 2);
				let startCol = 0;

				if (cursorCol < halfWidth) {
					// Cursor near start
					startCol = 0;
				} else if (cursorCol > totalWidth - halfWidth) {
					// Cursor near end
					startCol = Math.max(0, totalWidth - scrollWidth);
				} else {
					// Cursor in middle
					startCol = Math.max(0, cursorCol - halfWidth);
				}

				visibleText = sliceByColumn(this.value, startCol, scrollWidth, true);
				const beforeCursor = sliceByColumn(this.value, startCol, Math.max(0, cursorCol - startCol), true);
				cursorDisplay = beforeCursor.length;
			} else {
				visibleText = "";
				cursorDisplay = 0;
			}
		}

		// Build line with fake cursor
		// Insert cursor character at cursor position
		const graphemes = [...segmenter.segment(visibleText.slice(cursorDisplay))];
		const cursorGrapheme = graphemes[0];

		const beforeCursor = visibleText.slice(0, cursorDisplay);
		const atCursor = cursorGrapheme?.segment ?? " "; // Character at cursor, or space if at end
		const afterCursor = visibleText.slice(cursorDisplay + atCursor.length);

		// Hardware cursor marker (zero-width, emitted before fake cursor for IME positioning)
		const marker = this.focused ? CURSOR_MARKER : "";

		// Use inverse video to show cursor
		const cursorChar = `\x1b[7m${atCursor}\x1b[27m`; // ESC[7m = reverse video, ESC[27m = normal
		const textWithCursor = beforeCursor + marker + cursorChar + afterCursor;

		// Calculate visual width
		const visualLength = visibleWidth(textWithCursor);
		const padding = " ".repeat(Math.max(0, availableWidth - visualLength));
		const line = prompt + textWithCursor + padding;

		return [line];
	}
}
