/**
 * Shared truncation utilities for tool outputs.
 *
 * Truncation is based on two independent limits - whichever is hit first wins:
 * - Line limit (default: 2000 lines)
 * - Byte limit (default: 50KB)
 *
 * Never returns partial lines (except bash tail truncation edge case).
 */

import { isTruthyEnvFlag } from "../../utils/env-flags.js";
import { sliceSafe } from "../../utils/surrogate.js";

export const DEFAULT_MAX_LINES = 2000;

// ---------------------------------------------------------------------------
// Context-window-proportional byte caps.
//
// The three shared BYTE budgets below scale with the boot-time model's context
// window: at or under a 200k-token window they keep their historical floors
// (byte-identical to the old constants), then grow LINEARLY up to 2× the floor
// at a 1M-token window (clamped there). Rationale: on a 1M window the 50KB read
// cap truncates output the window could comfortably hold, while on small
// windows the floors are already the right protection. Mirrors
// `proactivePruneFloor`'s window-proportional pattern (compaction.ts), but is
// configured ONCE at session init (AgentSession's constructor) because these
// caps are imported as plain values by ~15 modules: the exports are mutable
// (`let`) ES-module live bindings, so every importer reads the reconfigured
// value at call time with zero call-site churn. Only byte caps scale — line
// limits and the bash head sub-budget stay fixed (bytes are what track window
// size; line counts track readability).
//
// Process-global by design: a later /model switch does not re-scale (same
// convention as the session recovery thermostat seeded from the boot-time
// model), and when several sessions share one process the last one constructed
// wins — acceptable because every value stays within [floor, 2×floor].

/** Context window (tokens) at or under which the byte caps keep their floors. */
const CAP_SCALE_BASE_WINDOW = 200_000;
/** Context window (tokens) at or over which the byte caps reach 2× the floor. */
const CAP_SCALE_MAX_WINDOW = 1_000_000;

const DEFAULT_MAX_BYTES_FLOOR = 50 * 1024; // 50KB
const TOOL_OUTPUT_HARD_CAP_FLOOR = 64 * 1024; // 64KB
const BASH_MAX_BYTES_FLOOR = 24 * 1024; // 24KB

export let DEFAULT_MAX_BYTES = DEFAULT_MAX_BYTES_FLOOR;
// Safety-net ceiling applied generically in wrapToolDefinition to every tool
// result. Kept well above the per-tool cap (read/grep/lsp/mcp use
// DEFAULT_MAX_BYTES) so tools that already truncate — and their own truncation
// notes — are never re-cut; this only catches tool outputs with no cap of their
// own (many extensions and some MCP returns). Scales with the SAME factor as
// DEFAULT_MAX_BYTES so the "sits above the per-tool cap" invariant holds at
// every window size.
export let TOOL_OUTPUT_HARD_CAP_BYTES = TOOL_OUTPUT_HARD_CAP_FLOOR;

/**
 * Linear cap scale for a model context window: 1 at ≤200k tokens (historical
 * behavior), 2 at ≥1M, straight line in between. Exported for tests.
 */
export function truncationCapScale(contextWindow: number): number {
	if (!Number.isFinite(contextWindow) || contextWindow <= CAP_SCALE_BASE_WINDOW) return 1;
	const clamped = Math.min(contextWindow, CAP_SCALE_MAX_WINDOW);
	return 1 + (clamped - CAP_SCALE_BASE_WINDOW) / (CAP_SCALE_MAX_WINDOW - CAP_SCALE_BASE_WINDOW);
}

/**
 * Scale the shared byte caps for the given model context window. Deterministic
 * from the floors — repeated calls never compound — and `contextWindow <= 0`
 * (or a non-finite value) resets everything to the floors, which tests use to
 * restore the historical defaults.
 */
export function configureTruncationCaps(options: { contextWindow: number }): void {
	const scale = truncationCapScale(options.contextWindow);
	DEFAULT_MAX_BYTES = Math.round(DEFAULT_MAX_BYTES_FLOOR * scale);
	TOOL_OUTPUT_HARD_CAP_BYTES = Math.round(TOOL_OUTPUT_HARD_CAP_FLOOR * scale);
	BASH_MAX_BYTES = Math.round(BASH_MAX_BYTES_FLOOR * scale);
	// Occupancy scale is applied on top of these boot floors; reset to full
	// until the next tool call refreshes from getContextUsage().
	_occupancyScale = 1;
}

/** Occupancy at which live truncation caps start tightening (mirrors prune). */
const OCCUPANCY_CAP_START = 0.5;
/** Occupancy at/above which caps reach the floor fraction. */
const OCCUPANCY_CAP_FULL = 0.9;
/** Minimum fraction of the boot-scaled cap retained under high occupancy. */
const OCCUPANCY_CAP_FLOOR_FRACTION = 0.25;

/**
 * Scale factor for live tool-output byte caps given context occupancy.
 * 1.0 at ≤50% fill; linear down to {@link OCCUPANCY_CAP_FLOOR_FRACTION} at ≥90%.
 * Exported for tests. Does not mutate boot floors — callers multiply.
 */
export function occupancyCapScale(occupancy: number): number {
	if (!Number.isFinite(occupancy) || occupancy <= OCCUPANCY_CAP_START) return 1;
	if (occupancy >= OCCUPANCY_CAP_FULL) return OCCUPANCY_CAP_FLOOR_FRACTION;
	const span = OCCUPANCY_CAP_FULL - OCCUPANCY_CAP_START;
	const t = (occupancy - OCCUPANCY_CAP_START) / span;
	return 1 - t * (1 - OCCUPANCY_CAP_FLOOR_FRACTION);
}

/** Current occupancy multiplier applied on top of boot-scaled caps (1 = full). */
let _occupancyScale = 1;

/**
 * Refresh the live occupancy multiplier from context usage. Called before each
 * tool execute so read/grep/bash see tighter caps as the window fills — without
 * mutating the boot floors permanently (multi-session safe: last refresh wins
 * per call, same convention as configureTruncationCaps).
 */
export function refreshOccupancyTruncationCaps(
	usage:
		| {
				percent?: number | null;
				tokens?: number | null;
				contextWindow?: number | null;
		  }
		| null
		| undefined,
): void {
	if (isTruthyEnvFlag(process.env.PIT_NO_OCCUPANCY_CAPS)) {
		_occupancyScale = 1;
		return;
	}
	if (!usage) {
		_occupancyScale = 1;
		return;
	}
	let occupancy: number;
	if (typeof usage.percent === "number" && Number.isFinite(usage.percent)) {
		occupancy = usage.percent / 100;
	} else if (typeof usage.tokens === "number" && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
		occupancy = usage.tokens / usage.contextWindow;
	} else {
		_occupancyScale = 1;
		return;
	}
	_occupancyScale = occupancyCapScale(occupancy);
}

/** Current occupancy multiplier applied on top of boot-scaled caps (1 = full). */
export function getOccupancyScale(): number {
	return _occupancyScale;
}

/** Effective DEFAULT_MAX_BYTES after occupancy scaling (for call sites / notices). */
export function effectiveDefaultMaxBytes(): number {
	return Math.max(1, Math.round(DEFAULT_MAX_BYTES * _occupancyScale));
}

/** Effective BASH_MAX_BYTES after occupancy scaling. */
export function effectiveBashMaxBytes(): number {
	return Math.max(1, Math.round(BASH_MAX_BYTES * _occupancyScale));
}

/** Effective hard-cap after occupancy scaling (wrapper safety net). */
export function effectiveToolOutputHardCapBytes(): number {
	return Math.max(1, Math.round(TOOL_OUTPUT_HARD_CAP_BYTES * _occupancyScale));
}

// Dedicated, larger ceiling for `recall_tool_output`. A deferred output is only
// stored when it exceeds the compaction prune threshold (~20k dense tokens ≈ 66KB
// of text), so it is ALWAYS bigger than the generic 64KB hard cap — re-cutting it
// head-only on recall would drop exactly the tail (final error/stack/status) the
// model recalled it for. 96KB keeps the recalled excerpt large enough to carry
// both head and tail while bounding how much a single recall can re-inject
// (~24K tokens worst case) so one recall cannot dominate the context window.
// Fixed: stays above the scaled hard cap even at its 128KB ceiling when scaled
// hard caps are lower; when hard cap is at 128KB floor, recall remains the
// intentional higher ceiling for deferred outputs only.
export const RECALL_OUTPUT_CAP_BYTES = 96 * 1024; // 96KB
// Ceiling for a THROWN tool error's message text (see wrapToolDefinition's
// capThrownError): a throwing tool bypasses the resolved-result caps, and error
// signal lives at both ends (message head, final stack frames), so the cap is
// applied head+tail. Fixed — error text does not become more valuable on a
// bigger window.
export const ERROR_TEXT_CAP_BYTES = 16 * 1024; // 16KB
export const GREP_MAX_LINE_LENGTH = 500; // Max chars per grep match line

// Bash gets a tighter budget than file reads: command output (build/test logs,
// dumps) is rarely worth 50KB of context, whereas a source file read often is.
// Bash truncates from the tail (errors land at the end), so the cap mostly trims
// verbose middles. Full output is always persisted to a temp file when truncated.
export const BASH_MAX_LINES = 1000;
export let BASH_MAX_BYTES = BASH_MAX_BYTES_FLOOR; // 24KB floor

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

/** Default: collapse a run of this many identical/similar consecutive lines or more. */
const DEFAULT_COLLAPSE_MIN_RUN = 3;

/**
 * Minimum length of a hex run masked as a single wildcard token (hashes, uuids
 * without dashes, memory addresses). Shorter hex-looking words (e.g. "cafe") stay
 * literal so ordinary text is never masked; only digit runs are masked at any
 * length (timestamps, counters, percentages), which is where CI/test-runner noise
 * lives.
 */
const HEX_TOKEN_MIN_LEN = 8;

/**
 * Fuzzy collapse only fires when the masked line still carries at least this many
 * NON-masked (literal) characters. A line that masks down to almost nothing (e.g.
 * "#|#") is pure shape with no shared meaning, so two such distinct rows must NOT
 * be merged. Exact-identical lines collapse regardless of this floor — they carry
 * no extra information at all.
 */
const FUZZY_MIN_LITERAL_CHARS = 8;

function isAsciiDigit(code: number): boolean {
	return code >= 48 && code <= 57; // 0-9
}

function isHexDigit(code: number): boolean {
	return (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70); // 0-9 a-f A-F
}

/**
 * If a masked token begins at `i` within `s[i,end)`, return its end index
 * (exclusive); otherwise return `i` (no token — the char is literal). A masked
 * token is a maximal run of hex chars of length >= HEX_TOKEN_MIN_LEN, or else a
 * maximal run of ASCII digits (any length). Allocation-free mirror of
 * `s.replace(/[0-9a-fA-F]{8,}/g,"#").replace(/[0-9]+/g,"#")`: the long-hex run
 * wins when present, else the digit run.
 */
function maskedTokenEnd(s: string, i: number, end: number): number {
	const code = s.charCodeAt(i);
	if (isHexDigit(code)) {
		let h = i;
		while (h < end && isHexDigit(s.charCodeAt(h))) h++;
		if (h - i >= HEX_TOKEN_MIN_LEN) return h;
	}
	if (isAsciiDigit(code)) {
		let d = i;
		while (d < end && isAsciiDigit(s.charCodeAt(d))) d++;
		return d;
	}
	return i;
}

/** Compare two ranges (possibly across two strings) for byte equality, no slices. */
function rangesEqual(sa: string, aStart: number, aEnd: number, sb: string, bStart: number, bEnd: number): boolean {
	const aLen = aEnd - aStart;
	if (aLen !== bEnd - bStart) return false;
	for (let k = 0; k < aLen; k++) {
		if (sa.charCodeAt(aStart + k) !== sb.charCodeAt(bStart + k)) return false;
	}
	return true;
}

/**
 * Whether two ranges are equal after masking each digit/hex token to one wildcard.
 * Two-pointer walk, no allocation: where both sides start a masked token, skip both
 * tokens (they match regardless of the digits); a token on only one side, or a
 * mismatched literal char, fails. Lets "req 12" and "req 987" compare equal.
 */
function maskedRangesEqual(
	sa: string,
	aStart: number,
	aEnd: number,
	sb: string,
	bStart: number,
	bEnd: number,
): boolean {
	let a = aStart;
	let b = bStart;
	while (a < aEnd && b < bEnd) {
		const aTok = maskedTokenEnd(sa, a, aEnd);
		const bTok = maskedTokenEnd(sb, b, bEnd);
		const aIsTok = aTok > a;
		const bIsTok = bTok > b;
		if (aIsTok || bIsTok) {
			if (!aIsTok || !bIsTok) return false;
			a = aTok;
			b = bTok;
			continue;
		}
		if (sa.charCodeAt(a) !== sb.charCodeAt(b)) return false;
		a++;
		b++;
	}
	return a === aEnd && b === bEnd;
}

/** Count of literal (non-masked-token) chars in `s[start,end)`. */
function nonMaskedCount(s: string, start: number, end: number): number {
	let count = 0;
	let i = start;
	while (i < end) {
		const tok = maskedTokenEnd(s, i, end);
		if (tok > i) {
			i = tok; // a masked token contributes no literal chars
		} else {
			count++;
			i++;
		}
	}
	return count;
}

/**
 * Whether two consecutive lines belong to the same collapsible run: byte-identical
 * (exact — always collapses), or masked-equal with enough shared literal content
 * (fuzzy — see FUZZY_MIN_LITERAL_CHARS). Masked equality is transitive, so anchoring
 * every member of a run to its first line matches a consecutive-pair walk.
 */
function linesConnected(sa: string, aStart: number, aEnd: number, sb: string, bStart: number, bEnd: number): boolean {
	if (rangesEqual(sa, aStart, aEnd, sb, bStart, bEnd)) return true;
	if (!maskedRangesEqual(sa, aStart, aEnd, sb, bStart, bEnd)) return false;
	return nonMaskedCount(sa, aStart, aEnd) >= FUZZY_MIN_LITERAL_CHARS;
}

/**
 * Allocation-free scan for the presence of any run of `minRun` (or more)
 * collapsible consecutive lines (exact-identical or fuzzy-similar — see
 * {@link linesConnected}), where "line" matches `text.split("\n")` exactly
 * (newline-delimited segments, with a trailing empty segment for a trailing
 * newline). Returns true as soon as one such run is found, letting
 * `collapseRepeatedLines` skip the full split/array/join when nothing collapses.
 */
function hasCollapsibleRun(text: string, minRun: number): boolean {
	const len = text.length;
	// Start/end (exclusive) of the previous segment, and how many consecutive
	// segments (including the previous one) have collapsed together so far.
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
		if (hasPrev && linesConnected(text, prevStart, prevEnd, text, segStart, segEnd)) {
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

/**
 * Collapse runs of identical OR fuzzy-similar consecutive lines to shrink verbose
 * command output before it reaches the LLM (repeated log/test/progress/warning
 * lines). Lines are compared with numeric/hex tokens masked to a wildcard, so a
 * CI/test wall that differs only in timestamps, counters, or percentages collapses
 * too — a run of `minRun` or more becomes the FIRST line verbatim + a count marker
 * (`… (×N)` when the lines were byte-identical, `… (×N similar)` when they differed
 * only inside masked tokens). Runs of blank lines collapse to a single blank line.
 * Only CONSECUTIVE lines are merged, so order and distinct content are preserved.
 * Command-agnostic and upgrade-only: text with no collapsible run is byte-identical.
 */
export function collapseRepeatedLines(text: string, minRun = DEFAULT_COLLAPSE_MIN_RUN): string {
	if (!text || minRun < 2) return text;
	// Fast path: scan for the first collapsible run without allocating. The common
	// case (bash/check output with no collapsible run) returns the original string
	// here, skipping the full split/array/join.
	if (!hasCollapsibleRun(text, minRun)) return text;
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const anchor = lines[i];
		let j = i + 1;
		let allExact = true;
		while (j < lines.length && linesConnected(anchor, 0, anchor.length, lines[j], 0, lines[j].length)) {
			if (lines[j] !== anchor) allExact = false;
			j++;
		}
		const run = j - i;
		if (run >= minRun) {
			if (anchor.trim() === "") {
				out.push("");
			} else {
				out.push(allExact ? `${anchor} … (×${run})` : `${anchor} … (×${run} similar)`);
			}
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
	const maxBytes = options.maxBytes ?? effectiveDefaultMaxBytes();

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
	const maxBytes = options.maxBytes ?? effectiveDefaultMaxBytes();

	const fastPath = tryNoTruncation(content, maxLines, maxBytes);
	if (fastPath) return fastPath;

	const totalBytes = utf8ByteLength(content);
	const lines = content.split("\n");
	const totalLines = lines.length;

	// Work backwards from the end. Push then reverse once — unshift-in-loop is O(n²).
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
				outputLinesArr.push(truncatedLine);
				outputBytesCount = utf8ByteLength(truncatedLine);
				lastLinePartial = true;
			}
			break;
		}

		outputLinesArr.push(line);
		outputBytesCount += lineBytes;
	}

	outputLinesArr.reverse();

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
	const maxBytes = options.maxBytes ?? effectiveDefaultMaxBytes();
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
