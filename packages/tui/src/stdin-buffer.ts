/**
 * StdinBuffer buffers input and emits complete sequences.
 *
 * This is necessary because stdin data events can arrive in partial chunks,
 * especially for escape sequences like mouse events. Without buffering,
 * partial sequences can be misinterpreted as regular keypresses.
 *
 * For example, the mouse SGR sequence `\x1b[<35;20;5m` might arrive as:
 * - Event 1: `\x1b`
 * - Event 2: `[<35`
 * - Event 3: `;20;5m`
 *
 * The buffer accumulates these until a complete sequence is detected.
 * Call the `process()` method to feed input data.
 *
 * Based on code from OpenTUI (https://github.com/anomalyco/opentui)
 * MIT License - Copyright (c) 2025 opentui
 */

import { EventEmitter } from "events";

const ESC = "\x1b";
const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

// Cap for the bracketed-paste accumulator. An unterminated paste — interrupted
// before the end marker arrives, a terminal that never emits one, or a blob
// sliced across chunks that overshoots — would otherwise let pasteBuffer grow
// without bound (OOM) and trap us in paste mode forever (input swallowed). Once
// we exceed this with no end marker, we flush what we have (truncated) and exit
// paste mode. Generous so legitimate large pastes still complete normally.
const MAX_PASTE_BYTES = 10 * 1024 * 1024;

// Cap for the general escape-sequence accumulator (this.buffer). The pending
// flush timeout is cleared at the top of every process() call and only re-armed
// when a non-empty remainder survives extractCompleteSequences(). A continuous
// stream that never forms a complete sequence — an endless unterminated CSI
// ('\x1b[' followed by an unbroken run of digits/';', each candidate ending in a
// byte < 0x40 so it stays "incomplete"), or an SGR-mouse '\x1b[<99999...' that
// never closes — arriving faster than timeoutMs would clear the timeout before
// it can fire and let this.buffer grow without bound (OOM). Mirroring the
// MAX_PASTE_BYTES guard, once the remainder exceeds this cap we force-flush the
// buffered content as data and reset, so growth is bounded even when no chunk
// gap ever reaches timeoutMs. Generous so legitimate long sequences still buffer
// normally before completion.
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

/**
 * Check if a string is a complete escape sequence or needs more data
 */
function isCompleteSequence(data: string): "complete" | "incomplete" | "not-escape" {
	if (!data.startsWith(ESC)) {
		return "not-escape";
	}

	if (data.length === 1) {
		return "incomplete";
	}

	const afterEsc = data.slice(1);

	// CSI sequences: ESC [
	if (afterEsc.startsWith("[")) {
		// Check for old-style mouse sequence: ESC[M + 3 bytes
		if (afterEsc.startsWith("[M")) {
			// Old-style mouse needs ESC[M + 3 bytes = 6 total
			return data.length >= 6 ? "complete" : "incomplete";
		}
		return isCompleteCsiSequence(data);
	}

	// OSC sequences: ESC ]
	if (afterEsc.startsWith("]")) {
		return isCompleteOscSequence(data);
	}

	// DCS sequences: ESC P ... ESC \ (includes XTVersion responses)
	if (afterEsc.startsWith("P")) {
		return isCompleteDcsSequence(data);
	}

	// APC sequences: ESC _ ... ESC \ (includes Kitty graphics responses)
	if (afterEsc.startsWith("_")) {
		return isCompleteApcSequence(data);
	}

	// SS3 sequences: ESC O
	if (afterEsc.startsWith("O")) {
		// ESC O followed by a single character
		return afterEsc.length >= 2 ? "complete" : "incomplete";
	}

	// Meta key sequences: ESC followed by a single character
	if (afterEsc.length === 1) {
		return "complete";
	}

	// Unknown escape sequence - treat as complete
	return "complete";
}

/**
 * Check if CSI sequence is complete
 * CSI sequences: ESC [ ... followed by a final byte (0x40-0x7E)
 */
function isCompleteCsiSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}[`)) {
		return "complete";
	}

	// Need at least ESC [ and one more character
	if (data.length < 3) {
		return "incomplete";
	}

	const payload = data.slice(2);

	// CSI sequences end with a byte in the range 0x40-0x7E (@-~)
	// This includes all letters and several special characters
	const lastChar = payload[payload.length - 1];
	const lastCharCode = lastChar.charCodeAt(0);

	if (lastCharCode >= 0x40 && lastCharCode <= 0x7e) {
		// Special handling for SGR mouse sequences
		// Format: ESC[<B;X;Ym or ESC[<B;X;YM
		if (payload.startsWith("<")) {
			// Must have format: <digits;digits;digits[Mm]
			const mouseMatch = /^<\d+;\d+;\d+[Mm]$/.test(payload);
			if (mouseMatch) {
				return "complete";
			}
			// If it ends with M or m but doesn't match the pattern, still incomplete
			if (lastChar === "M" || lastChar === "m") {
				// Check if we have the right structure
				const parts = payload.slice(1, -1).split(";");
				if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
					return "complete";
				}
			}

			return "incomplete";
		}

		return "complete";
	}

	return "incomplete";
}

/**
 * Check if OSC sequence is complete
 * OSC sequences: ESC ] ... ST (where ST is ESC \ or BEL)
 */
function isCompleteOscSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}]`)) {
		return "complete";
	}

	// OSC sequences end with ST (ESC \) or BEL (\x07)
	if (data.endsWith(`${ESC}\\`) || data.endsWith("\x07")) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if DCS (Device Control String) sequence is complete
 * DCS sequences: ESC P ... ST (where ST is ESC \)
 * Used for XTVersion responses like ESC P >| ... ESC \
 */
function isCompleteDcsSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}P`)) {
		return "complete";
	}

	// DCS sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Check if APC (Application Program Command) sequence is complete
 * APC sequences: ESC _ ... ST (where ST is ESC \)
 * Used for Kitty graphics responses like ESC _ G ... ESC \
 */
function isCompleteApcSequence(data: string): "complete" | "incomplete" {
	if (!data.startsWith(`${ESC}_`)) {
		return "complete";
	}

	// APC sequences end with ST (ESC \)
	if (data.endsWith(`${ESC}\\`)) {
		return "complete";
	}

	return "incomplete";
}

/**
 * Split accumulated buffer into complete sequences
 */
function parseUnmodifiedKittyPrintableCodepoint(sequence: string): number | undefined {
	const match = sequence.match(/^\x1b\[(\d+)(?::\d*)?(?::\d+)?u$/);
	if (!match) return undefined;

	const codepoint = parseInt(match[1]!, 10);
	return codepoint >= 32 ? codepoint : undefined;
}

function extractCompleteSequences(buffer: string): { sequences: string[]; remainder: string } {
	const sequences: string[] = [];
	let pos = 0;

	while (pos < buffer.length) {
		const remaining = buffer.slice(pos);

		// Try to extract a sequence starting at this position
		if (remaining.startsWith(ESC)) {
			// Find the end of this escape sequence
			let seqEnd = 1;
			while (seqEnd <= remaining.length) {
				const candidate = remaining.slice(0, seqEnd);
				const status = isCompleteSequence(candidate);

				if (status === "complete") {
					// WezTerm with enable_kitty_keyboard sends the Escape key press as a
					// raw '\x1b' byte (simple text path in encode_kitty, ignoring
					// DISAMBIGUATE_ESCAPE_CODES) and the release as a full Kitty CSI-u
					// sequence. These arrive concatenated as '\x1b\x1b[27;...u'.
					// The buffer would normally treat '\x1b\x1b' as a complete meta-key
					// sequence (ESC + single char), leaving '[27;...u' to be typed as
					// plain text. If the character immediately following '\x1b\x1b'
					// would begin a new escape sequence, emit only the first ESC and
					// restart from the second.
					if (candidate === "\x1b\x1b") {
						const nextChar = remaining[seqEnd];
						if (
							nextChar === "[" || // CSI
							nextChar === "]" || // OSC
							nextChar === "O" || // SS3
							nextChar === "P" || // DCS
							nextChar === "_" // APC
						) {
							sequences.push(ESC);
							pos += 1;
							break;
						}
					}
					sequences.push(candidate);
					pos += seqEnd;
					break;
				} else if (status === "incomplete") {
					seqEnd++;
				} else {
					// Should not happen when starting with ESC
					sequences.push(candidate);
					pos += seqEnd;
					break;
				}
			}

			if (seqEnd > remaining.length) {
				return { sequences, remainder: remaining };
			}
		} else {
			// Not an escape sequence - take a single character. Astral-plane
			// characters (emoji, CJK extensions, math symbols) are encoded as a
			// UTF-16 surrogate PAIR (two code units); emit the whole pair as one
			// sequence so downstream key matching never sees a lone surrogate.
			const code = remaining.charCodeAt(0);
			if (code >= 0xd800 && code <= 0xdbff) {
				if (remaining.length > 1) {
					const low = remaining.charCodeAt(1);
					if (low >= 0xdc00 && low <= 0xdfff) {
						sequences.push(remaining.slice(0, 2));
						pos += 2;
						continue;
					}
				} else {
					// Lone high surrogate at the buffer tail: its low surrogate may
					// still be arriving in the next chunk. Hold it as the remainder so
					// the pair is reassembled and emitted whole, instead of emitting a
					// lone surrogate now and another lone surrogate next chunk.
					return { sequences, remainder: remaining };
				}
			}
			sequences.push(remaining[0]!);
			pos++;
		}
	}

	return { sequences, remainder: "" };
}

export type StdinBufferOptions = {
	/**
	 * Maximum time to wait for sequence completion (default: 10ms)
	 * After this time, the buffer is flushed even if incomplete
	 */
	timeout?: number;
};

export type StdinBufferEventMap = {
	data: [string];
	paste: [string];
};

/**
 * Buffers stdin input and emits complete sequences via the 'data' event.
 * Handles partial escape sequences that arrive across multiple chunks.
 */
export class StdinBuffer extends EventEmitter<StdinBufferEventMap> {
	private buffer: string = "";
	private timeout: ReturnType<typeof setTimeout> | null = null;
	private readonly timeoutMs: number;
	private pasteMode: boolean = false;
	private pasteBuffer: string = "";
	private pendingKittyPrintableCodepoint: number | undefined;

	constructor(options: StdinBufferOptions = {}) {
		super();
		this.timeoutMs = options.timeout ?? 10;
	}

	public process(data: string | Buffer): void {
		// Clear any pending timeout
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		// Handle high-byte conversion (for compatibility with parseKeypress)
		// If buffer has single byte > 127, convert to ESC + (byte - 128)
		let str: string;
		if (Buffer.isBuffer(data)) {
			if (data.length === 1 && data[0]! > 127) {
				const byte = data[0]! - 128;
				str = `\x1b${String.fromCharCode(byte)}`;
			} else {
				str = data.toString();
			}
		} else {
			str = data;
		}

		if (str.length === 0 && this.buffer.length === 0) {
			this.emitDataSequence("");
			return;
		}

		this.buffer += str;

		// A completed paste can leave a remainder that itself contains further
		// paste markers (a malformed terminal stream, or pasted content that
		// embeds paste markers). Feeding that remainder back through the same
		// logic must NOT recurse — thousands of back-to-back paste pairs in a
		// single chunk would otherwise overflow the V8 stack. Drive it with a
		// loop instead so N paste pairs use O(1) stack. On each re-feed the
		// remainder is assigned straight into this.buffer (already emptied by the
		// paste handling), equivalent to the prior `this.process(remaining)`
		// whose str-append landed on an empty buffer; the empty-input early
		// return never applied because the remainder is always non-empty.
		for (;;) {
			if (this.pasteMode) {
				// Search only from near the previous tail: a bracketed-paste end marker
				// can't begin before (prevLen - (END.length - 1)) without having been
				// found last chunk, so re-scanning the whole accumulated buffer every
				// chunk (O(N^2) over a byte-at-a-time paste) is wasted work.
				const prevLen = this.pasteBuffer.length;
				this.pasteBuffer += this.buffer;
				this.buffer = "";

				const searchFrom = Math.max(0, prevLen - (BRACKETED_PASTE_END.length - 1));
				const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END, searchFrom);
				if (endIndex !== -1) {
					const pastedContent = this.pasteBuffer.slice(0, endIndex);
					const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

					this.pasteMode = false;
					this.pasteBuffer = "";
					this.pendingKittyPrintableCodepoint = undefined;

					this.emit("paste", pastedContent);

					if (remaining.length > 0) {
						this.buffer = remaining;
						continue;
					}
					return;
				}

				// No end marker yet: guard against an unterminated paste growing without
				// bound. Flush the (truncated) content and exit paste mode so subsequent
				// input is no longer swallowed.
				if (this.pasteBuffer.length > MAX_PASTE_BYTES) {
					const pastedContent = this.pasteBuffer.slice(0, MAX_PASTE_BYTES);
					this.pasteMode = false;
					this.pasteBuffer = "";
					this.pendingKittyPrintableCodepoint = undefined;
					this.emit("paste", pastedContent);
				}
				return;
			}

			const startIndex = this.buffer.indexOf(BRACKETED_PASTE_START);
			if (startIndex !== -1) {
				if (startIndex > 0) {
					const beforePaste = this.buffer.slice(0, startIndex);
					const result = extractCompleteSequences(beforePaste);
					for (const sequence of result.sequences) {
						this.emitDataSequence(sequence);
					}
				}

				this.pendingKittyPrintableCodepoint = undefined;
				this.buffer = this.buffer.slice(startIndex + BRACKETED_PASTE_START.length);
				this.pasteMode = true;
				this.pasteBuffer = this.buffer;
				this.buffer = "";

				const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
				if (endIndex !== -1) {
					const pastedContent = this.pasteBuffer.slice(0, endIndex);
					const remaining = this.pasteBuffer.slice(endIndex + BRACKETED_PASTE_END.length);

					this.pasteMode = false;
					this.pasteBuffer = "";
					this.pendingKittyPrintableCodepoint = undefined;

					this.emit("paste", pastedContent);

					if (remaining.length > 0) {
						this.buffer = remaining;
						continue;
					}
				}
				return;
			}

			const result = extractCompleteSequences(this.buffer);
			this.buffer = result.remainder;

			for (const sequence of result.sequences) {
				this.emitDataSequence(sequence);
			}

			// Bound the remainder: a stream that never completes a sequence would
			// otherwise accumulate forever because the flush timeout is cleared each
			// process() call before it can fire. Force-flush what we have as data and
			// reset so growth stays bounded even with no chunk gap >= timeoutMs.
			if (this.buffer.length > MAX_BUFFER_BYTES) {
				const forced = this.buffer;
				this.buffer = "";
				this.pendingKittyPrintableCodepoint = undefined;
				this.emitDataSequence(forced);
				return;
			}

			if (this.buffer.length > 0) {
				this.timeout = setTimeout(() => {
					const flushed = this.flush();

					for (const sequence of flushed) {
						this.emitDataSequence(sequence);
					}
				}, this.timeoutMs);
			}
			return;
		}
	}

	private emitDataSequence(sequence: string): void {
		const rawCodepoint = sequence.length === 1 ? sequence.codePointAt(0) : undefined;
		if (rawCodepoint !== undefined && rawCodepoint === this.pendingKittyPrintableCodepoint) {
			this.pendingKittyPrintableCodepoint = undefined;
			return;
		}

		this.pendingKittyPrintableCodepoint = parseUnmodifiedKittyPrintableCodepoint(sequence);
		this.emit("data", sequence);
	}

	flush(): string[] {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}

		if (this.buffer.length === 0) {
			return [];
		}

		const sequences = [this.buffer];
		this.buffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
		return sequences;
	}

	clear(): void {
		if (this.timeout) {
			clearTimeout(this.timeout);
			this.timeout = null;
		}
		this.buffer = "";
		this.pasteMode = false;
		this.pasteBuffer = "";
		this.pendingKittyPrintableCodepoint = undefined;
	}

	getBuffer(): string {
		return this.buffer;
	}

	destroy(): void {
		this.clear();
	}
}
