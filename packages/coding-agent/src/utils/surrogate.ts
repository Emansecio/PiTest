/**
 * Surrogate-safe string slicing.
 *
 * A plain `str.slice(start, end)` cuts on UTF-16 code units, so a boundary that
 * lands between a high surrogate (U+D800–U+DBFF) and its low surrogate
 * (U+DC00–U+DFFF) splits an astral char (emoji / CJK extension), leaving a lone
 * surrogate that renders as U+FFFD. These helpers nudge the boundary off such a
 * split. For all-BMP input they are byte-identical to `String.prototype.slice`.
 */

export function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
	return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * `str.slice(start, end)` that never splits a surrogate pair at either boundary:
 * a start landing on a lone low surrogate advances by one; an end splitting a
 * pair retreats by one. `end` defaults to the string length.
 */
export function sliceSafe(str: string, start: number, end: number = str.length): string {
	let lo = Math.max(0, start);
	let hi = Math.min(str.length, end);
	if (hi <= lo) return "";
	// Don't begin on a lone low surrogate whose high half was cut off.
	if (lo > 0 && isLowSurrogate(str.charCodeAt(lo)) && isHighSurrogate(str.charCodeAt(lo - 1))) {
		lo += 1;
	}
	// Don't end between a high surrogate and its low half.
	if (hi < str.length && isHighSurrogate(str.charCodeAt(hi - 1)) && isLowSurrogate(str.charCodeAt(hi))) {
		hi -= 1;
	}
	if (hi <= lo) return "";
	return str.slice(lo, hi);
}

/**
 * Truncate to at most `max` characters, appending `ellipsis` when the string is
 * cut — without splitting a surrogate pair at the cut. Returns the string
 * unchanged when it already fits. Mirrors the common `s.slice(0, max - 1) + "…"`
 * idiom but surrogate-safe.
 */
export function truncateWithEllipsis(str: string, max: number, ellipsis = "…"): string {
	if (str.length <= max) return str;
	return sliceSafe(str, 0, Math.max(0, max - ellipsis.length)) + ellipsis;
}
