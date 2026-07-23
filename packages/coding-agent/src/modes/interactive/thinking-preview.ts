/**
 * Pure text-shaping helpers for the working-loader "thinking preview": a
 * compact, one-line tail of the model's extended-thinking stream, shown next
 * to the "Thinking…" phase label while a turn reasons and before it starts
 * writing/calling tools. Ephemeral by construction — these functions only
 * transform text; lifecycle (accumulation, throttling, show/hide) lives in
 * interactive-mode.ts, which owns the clock and the loader instance.
 */

/**
 * Sanitize raw extended-thinking text into dense, single-line-safe prose:
 * drop fenced code blocks (including one still open mid-stream — a
 * half-written code dump is not useful in a one-line preview), strip inline
 * backticks and leading markdown structural markers (#, *, -), then collapse
 * all newlines/whitespace runs to single spaces.
 */
export function sanitizeThinkingText(raw: string): string {
	if (!raw) return "";
	const withoutFences = raw
		// Complete fenced code blocks: drop entirely (open + close on the
		// accumulated text so far).
		.replace(/```[\s\S]*?```/g, " ")
		// A fence opened but never closed (still streaming inside it): drop the
		// remainder rather than surface a half-written code block.
		.replace(/```[\s\S]*$/, " ");
	const withoutStructuralMarkers = withoutFences
		.split(/\r?\n/)
		.map((line) => line.replace(/^\s*(?:#{1,6}|[-*])\s+/, ""))
		.join(" ");
	return withoutStructuralMarkers.replace(/`/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Extract the trailing, currently-live edge of accumulated thinking text as a
 * single dense line: sanitizes the raw text, then — if it overflows
 * `maxWidth` — cuts to the last `maxWidth` characters, backs off to the next
 * word boundary so the visible fragment never opens mid-word, and prefixes an
 * ellipsis to mark the truncation. Returns "" for empty/whitespace-only input
 * or a non-positive width. Pure: no clock, no I/O — safe to unit test
 * directly.
 */
export function deriveThinkingTail(rawAccumulatedText: string, maxWidth: number): string {
	const sanitized = sanitizeThinkingText(rawAccumulatedText);
	if (!sanitized || maxWidth <= 0) return "";
	if (sanitized.length <= maxWidth) return sanitized;
	const ellipsis = "…";
	// Reserve room for the ellipsis prefix so the final string never exceeds maxWidth.
	const budget = Math.max(1, maxWidth - ellipsis.length);
	let tail = sanitized.slice(-budget);
	// Back off to the next word boundary: an inner space means the slice opened
	// mid-word, so drop the partial fragment before it.
	const spaceIdx = tail.indexOf(" ");
	if (spaceIdx !== -1 && spaceIdx < tail.length - 1) {
		tail = tail.slice(spaceIdx + 1);
	}
	return `${ellipsis}${tail}`;
}
