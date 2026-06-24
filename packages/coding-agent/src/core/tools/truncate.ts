/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

import { sliceSafe } from "../../utils/surrogate.js";

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024; // 50KB
// Safety-net ceiling applied generically in wrapToolDefinition to every tool
// result. Set well above the 50KB per-tool cap (read/grep/lsp/mcp use
// DEFAULT_MAX_BYTES) so tools that already truncate — and their own truncation
// notes — are never re-cut; this only catches tool outputs with no cap of their
// own (many extensions and some MCP returns).
export const TOOL_OUTPUT_HARD_CAP_BYTES = 64 * 1024; // 64KB
// Dedicated, larger ceiling for `recall_tool_output`. A deferred output is only
// stored when it exceeds the compaction prune threshold (~20k dense tokens ≈ 66KB
// of text), so it is ALWAYS bigger than the generic 64KB hard cap — re-cutting it
// head-only on recall would drop exactly the tail (final error/stack/status) the
// model recalled it for. 256KB keeps the recalled excerpt large enough to carry
// both head and tail while still bounding how much a single recall can re-inject.
export const RECALL_OUTPUT_CAP_BYTES = 256 * 1024; // 256KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

// Bash gets a tighter budget than file reads: command output (build/test logs,
// dumps) is rarely worth 50KB of context, whereas a source file read often is.
// Bash truncates from the tail (errors land at the end), so the cap mostly trims
// verbose middles. Full output is always persisted to a temp file when truncated.
export const BASH_MAX_LINES = 1000;
export const BASH_MAX_BYTES = 24 * 1024; // 24KB

// Head budget for bash head+tail truncation: retain the first lines (the command and
// early context) alongside the tail (where errors and summaries land), eliding only
// the middle. Kept well under the total budget so the tail still dominates.
export const BASH_HEAD_MAX_LINES = 120;
export const BASH_HEAD_MAX_BYTES = 4 * 1024; // 4KB

export interface TruncationResult {
	/** The truncated content */
	content: string;
	/** Whether truncation occurred */
	truncated: boolean;
	/** Which limit was hit: "lines", "bytes", or null if not truncated */
	truncatedBy: "lines" | "bytes" | null;
	/** Total number of lines in the original content */
	totalLines: number;
	/** Total number of bytes in the original content */
	totalBytes: number;
	/** Number of complete lines in the truncated output */
	outputLines: number;
	/** Number of bytes in the truncated output */
	outputBytes: number;
	/** Whether the last line was partially truncated (only for tail truncation edge case) */
	lastLinePartial: boolean;
	/** Whether the first line exceeded the byte limit (for head truncation) */
	firstLineExceedsLimit: boolean;
	/** The max lines limit that was applied */
	maxLines: number;
	/** The max bytes limit that was applied */
	maxBytes: number;
}

export interface TruncationOptions {
	/** Maximum number of lines (default: 2000) */
	maxLines?: number;
	/** Maximum number of bytes (default: 50KB) */
	maxBytes?: number;
}

/**
 * Format bytes as human-readable size.
 */
export function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Default: collapse a run of this many identical consecutive lines or more. */
const DEFAULT_COLLAPSE_MIN_RUN = 3;

/**
 * Allocation-free scan for the presence of any run of `minRun` (or more)
 * identical consecutive lines, where "line" matches `text.split("\n")` exactly
 * (newline-delimited segments, with a trailing empty segment for a trailing
 * newline). Returns true as soon as one such run is found, letting
 * `collapseRepeatedLines` skip the full split/array/join when nothing collapses.
 *
 * Equality is checked by comparing each newline-delimited segment against the
 * previous one via substring bounds — no per-line strings are allocated.
 */
function hasCollapsibleRun(text: string, minRun: number): boolean {
	const len = text.length;
	// Start/end (exclusive) of the previous segment, and how many consecutive
	// segments (including the previous one) have been identical so far.
	let prevStart = 0;
	let prevEnd = -1;
	let hasPrev = false;
	let runLength = 1;
	let segStart = 0;
	let i = 0;
	while (i <= len) {
		const isBoundary = i === len || text.charCodeAt(i) === 10;
		if (!isBoundary) {
			i++;
			continue;
		}
		const segEnd = i;
		if (hasPrev && segmentsEqual(text, prevStart, prevEnd, segStart, segEnd)) {
			runLength++;
			if (runLength >= minRun) return true;
		} else {
			runLength = 1;
		}
		prevStart = segStart;
		prevEnd = segEnd;
		hasPrev = true;
		segStart = i + 1;
		i++;
	}
	return false;
}

/** Compare two substrings of `text` for equality without allocating slices. */
function segmentsEqual(text: string, aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
	const aLen = aEnd - aStart;
	if (aLen !== bEnd - bStart) return false;
	for (let k = 0; k < aLen; k++) {
		if (text.charCodeAt(aStart + k) !== text.charCodeAt(bStart + k)) return false;
	}
	return true;
}

/**
 * Collapse runs of identical consecutive lines to shrink verbose command output
 * before it reaches the LLM (repeated log/test/progress/warning lines). A run of
 * `minRun` or more identical lines becomes one line + a `… (×N)` count marker;
 * runs of blank lines collapse to a single blank line. Only CONSECUTIVE
 * identical lines are merged, so order and distinct content are preserved.
 * Command-agnostic and lossless-of-meaning (identical lines carry no extra info).
 */
export function collapseRepeatedLines(text: string, minRun = DEFAULT_COLLAPSE_MIN_RUN): string {
	if (!text || minRun < 2) return text;
	// Fast path: scan for the first run of >= minRun identical consecutive lines
	// without allocating. The common case (bash/check output with no collapsible
	// run) returns the original string here, skipping the full split/array/join.
	if (!hasCollapsibleRun(text, minRun)) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		let j = i + 1;
		while (j < lines.length && lines[j] === lines[i]) j++;
		const run = j - i;
		if (run >= minRun) {
			out.push(lines[i].trim() === "" ? "" : `${lines[i]} … (×${run})`);
		} else {
			for (let k = i; k < j; k++) out.push(lines[k]);
		}
		i = j;
	}
	return out.join("\n");
}

/**
 * Count UTF-8 bytes for a string without allocating a Buffer.
 * Surrogate pairs (U+10000–U+10FFFF) count as 4 bytes; the low surrogate is
 * consumed so it is never counted separately.
 * A lone high surrogate at end-of-string (no following low surrogate) is treated
 * as a 3-byte sequence, matching V8's WTF-8 behaviour for unpaired surrogates.
 */
function utf8ByteLength(s: string): number {
	let bytes = 0;
	const len = s.length;
	for (let i = 0; i < len; i++) {
		const code = s.charCodeAt(i);
		if (code < 0x80) {
			bytes += 1;
		} else if (code < 0x800) {
			bytes += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			// Surrogate pair → 4 bytes; skip the trailing low surrogate.
			bytes += 4;
			i++;
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/**
 * Fast-path check: if content fits within both limits, return a no-truncation
 * result without splitting the string. Returns null when truncation is needed.
 *
 * Single-pass scan counts UTF-8 bytes and newlines simultaneously,
 * short-circuiting on the first limit exceeded. Replaces the previous
 * Buffer.byteLength + tryNoTruncation double-walk over the same string.
 */
function tryNoTruncation(content: string, maxLines: number, maxBytes: number): TruncationResult | null {
	let lineCount = 1;
	let byteCount = 0;
	const len = content.length;
	for (let i = 0; i < len; i++) {
		const code = content.charCodeAt(i);
		if (code === 10) {
			lineCount++;
			if (lineCount > maxLines) return null;
		}
		// UTF-8 byte width per UTF-16 code unit.
		if (code < 0x80) {
			byteCount += 1;
		} else if (code < 0x800) {
			byteCount += 2;
		} else if (code >= 0xd800 && code <= 0xdbff) {
			// Surrogate pair → 4 bytes; skip the trailing low surrogate.
			byteCount += 4;
			i++;
		} else {
			byteCount += 3;
		}
		if (byteCount > maxBytes) return null;
	}
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines: lineCount,
		totalBytes: byteCount,
		outputLines: lineCount,
		outputBytes: byteCount,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the head (keep first N lines/bytes).
 * Suitable for file reads where you want to see the beginning.
 *
 * Never returns partial lines. If first line exceeds byte limit,
 * returns empty content with firstLineExceedsLimit=true.
 */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const fastPath = tryNoTruncation(content, maxLines, maxBytes);
	if (fastPath) return fastPath;

	const totalBytes = utf8ByteLength(content);
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Check if first line alone exceeds byte limit
	const firstLineBytes = utf8ByteLength(lines[0]);
	if (firstLineBytes > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}

	// Collect complete lines that fit
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";

	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (i > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: outputBytesCount,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/**
 * Truncate content from the tail (keep last N lines/bytes).
 * Suitable for bash output where you want to see the end (errors, final results).
 *
 * May return partial first line if the last line of original content exceeds byte limit.
 */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

	const fastPath = tryNoTruncation(content, maxLines, maxBytes);
	if (fastPath) return fastPath;

	const totalBytes = utf8ByteLength(content);
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Work backwards from the end
	const outputLinesArr: string[] = [];
	let outputBytesCount = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;

	for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
		const line = lines[i];
		const lineBytes = utf8ByteLength(line) + (outputLinesArr.length > 0 ? 1 : 0); // +1 for newline

		if (outputBytesCount + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			// Edge case: if we haven't added ANY lines yet and this line exceeds maxBytes,
			// take the end of the line (partial)
			if (outputLinesArr.length === 0) {
				const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
				outputLinesArr.unshift(truncatedLine);
				outputBytesCount = utf8ByteLength(truncatedLine);
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.unshift(line);
		outputBytesCount += lineBytes;
	}

	// If we exited due to line limit
	if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
		truncatedBy = "lines";
	}

	const outputContent = outputLinesArr.join("\n");

	return {
		content: outputContent,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: outputLinesArr.length,
		outputBytes: outputBytesCount,
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

export interface HeadTailTruncationResult {
	/** The head + tail excerpt (or the original content when it already fits). */
	content: string;
	/** Whether any middle was elided. */
	truncated: boolean;
	/** Total bytes in the original content. */
	totalBytes: number;
	/** Total lines in the original content. */
	totalLines: number;
}

/**
 * Truncate content keeping BOTH the head and the tail, eliding only the middle.
 *
 * Tool outputs frequently carry their most decisive signal at the END (a stack
 * trace's exception line, a command's final status); a head-only cut discards
 * exactly that. Used by `recall_tool_output`, whose whole purpose is to re-fetch
 * a large deferred output — a head-only re-cut would defeat the recall.
 *
 * The byte budget is split between head and tail (default 50/50) and both halves
 * snap to whole lines via the existing `truncateHead`/`truncateTail` (so this never
 * duplicates their UTF-8 byte accounting). The elided middle is replaced by a
 * single marker line. Returns the original content unchanged when it already fits.
 */
export function truncateHeadTail(
	content: string,
	options: { maxBytes?: number; headFraction?: number } = {},
): HeadTailTruncationResult {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const headFraction = options.headFraction ?? 0.5;

	const fastPath = tryNoTruncation(content, Number.POSITIVE_INFINITY, maxBytes);
	if (fastPath) {
		return { content, truncated: false, totalBytes: fastPath.totalBytes, totalLines: fastPath.totalLines };
	}

	const totalBytes = utf8ByteLength(content);
	const totalLines = content.split("\n").length;

	const headBudget = Math.max(1, Math.floor(maxBytes * headFraction));
	const tailBudget = Math.max(1, maxBytes - headBudget);

	// Line-based ceilings only; the byte budget is what bounds the excerpt here.
	const head = truncateHead(content, { maxBytes: headBudget, maxLines: Number.POSITIVE_INFINITY });
	const tail = truncateTail(content, { maxBytes: tailBudget, maxLines: Number.POSITIVE_INFINITY });

	const headText = head.content;
	const tailText = tail.content;
	const keptBytes = head.outputBytes + tail.outputBytes;
	const elidedBytes = Math.max(0, totalBytes - keptBytes);

	const marker = `\n\n[... ${formatSize(elidedBytes)} (${totalLines} lines total) truncated from the middle ...]\n\n`;
	return { content: `${headText}${marker}${tailText}`, truncated: true, totalBytes, totalLines };
}

/**
 * Truncate a string to fit within a byte limit (from the end).
 * Handles multi-byte UTF-8 characters correctly.
 */
function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
	const buf = Buffer.from(str, "utf-8");
	if (buf.length <= maxBytes) {
		return str;
	}

	// Start from the end, skip maxBytes back
	let start = buf.length - maxBytes;

	// Find a valid UTF-8 boundary (start of a character)
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
		start++;
	}

	return buf.slice(start).toString("utf-8");
}

/** Leading context to keep before the match when centering a truncation window. */
const TRUNCATE_WINDOW_MARGIN = 80;

/**
 * Truncate a single line to max characters, adding [truncated] suffix.
 * Used for grep match lines.
 *
 * When `matchStart` (a 0-based char index of the match within the line) is
 * provided and the match would fall outside a leading slice(0, maxChars), the
 * window is centered on the match instead of taken from the head — otherwise a
 * match in a high column (minified/bundle/lockfile line) would be elided and the
 * emitted line would not contain the search term. An ellipsis marks each side
 * that was cut. Lines within `maxChars` are returned verbatim (identical to the
 * 2-arg behavior), so existing callers and tests are unaffected.
 */
export function truncateLine(
	line: string,
	maxChars: number = GREP_MAX_LINE_LENGTH,
	matchStart?: number,
): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	// Head truncation: match is absent, near the start, or already visible in the
	// leading slice. Keep the original behavior byte-for-byte.
	if (matchStart === undefined || matchStart < 0 || matchStart < maxChars - TRUNCATE_WINDOW_MARGIN) {
		return { text: `${sliceSafe(line, 0, maxChars)}... [truncated]`, wasTruncated: true };
	}
	// Center the window on the match so the search term survives truncation.
	const windowStart = Math.max(0, matchStart - TRUNCATE_WINDOW_MARGIN);
	const windowEnd = Math.min(line.length, windowStart + maxChars);
	const head = windowStart > 0 ? "…" : "";
	const tail = windowEnd < line.length ? "… [truncated]" : "";
	return { text: `${head}${sliceSafe(line, windowStart, windowEnd)}${tail}`, wasTruncated: true };
}
