/**
 * Pure text-shaping helpers for the working-loader "thinking preview": a
 * compact, one-line tail of the model's extended-thinking stream, shown next
 * to the "Thinking…" phase label while a turn reasons and before it starts
 * writing/calling tools. Ephemeral by construction — these functions only
 * transform text; lifecycle (accumulation, throttling, show/hide) lives in
 * interactive-mode.ts, which owns the clock and the loader instance.
 */

/**
 * How much of the buffer's tail deriveThinkingTail sanitizes per call. The
 * visible tail is ≤ maxWidth (~70) chars, so a few KB of context is always
 * enough; sanitizing only this window keeps the 300ms preview tick O(window +
 * appended delta) instead of re-running three regexes over the entire
 * accumulated stream (O(n²) over a long thinking turn).
 */
const SANITIZE_WINDOW_CHARS = 4096;

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
 * Incremental scan state for ``` fence markers over the accumulated thinking
 * buffer. The stream is append-only, so each tick only the new suffix is
 * scanned (resuming from `searchPos`, exactly like markdown.ts's scanFences
 * resume: the cursor advances 3 per match, and after a miss it is clamped to
 * length-2 so a marker straddling the append boundary is still found). Any
 * non-append input falls back to a full rescan, so results are always exact.
 * Module-level (not per-call) because the exported helpers are pure functions;
 * the cache is a memo — identical inputs still produce identical outputs.
 */
let fenceScanCache: { text: string; searchPos: number; indices: number[] } | null = null;

/**
 * Drop the module-level fence-scan memo. Call when a thinking phase ends so a
 * long prior buffer (hundreds of KB) is not retained until the next phase.
 */
export function clearFenceScanCache(): void {
	fenceScanCache = null;
}

/** Positions of every ``` marker in raw, ascending; incremental on appends. */
function getFenceIndices(raw: string): number[] {
	let searchPos = 0;
	let indices: number[] = [];
	const cached = fenceScanCache;
	if (cached && raw.length >= cached.text.length && raw.startsWith(cached.text)) {
		// Append (or identical) buffer: resume. The prefix scan cannot change
		// retroactively, so only the suffix from searchPos needs scanning.
		searchPos = cached.searchPos;
		indices = cached.indices;
	}
	let idx = raw.indexOf("```", searchPos);
	while (idx !== -1) {
		indices.push(idx);
		searchPos = idx + 3;
		idx = raw.indexOf("```", searchPos);
	}
	// A future marker can straddle the current end by at most 2 chars; clamping
	// the resume cursor here keeps the next tick's indexOf O(delta) even when
	// the buffer contains no fences at all.
	searchPos = Math.max(searchPos, Math.max(0, raw.length - 2));
	fenceScanCache = { text: raw, searchPos, indices };
	return indices;
}

/** Count of fence markers strictly before pos (binary search; indices ascending). */
function countFencesBefore(indices: number[], pos: number): number {
	let lo = 0;
	let hi = indices.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (indices[mid] < pos) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * Sanitize only the trailing `windowChars` of the buffer, reproducing what
 * sanitizeThinkingText(raw) would show at the tail:
 *
 * - An OPEN trailing fence hides everything from its ``` to the end, so the
 *   window is anchored at the opener (the visible tail is the prose before
 *   it), matching the full scan's `/```[\s\S]*$/` drop.
 * - When the window START lands inside a fenced block (odd fence count in the
 *   prefix — computed incrementally, never by rescanning the prefix), the
 *   window is advanced past that block's closing ```.
 * - When the cut lands mid-line, the partial first line is dropped so the
 *   line-anchored structural-marker stripping only ever sees real line starts.
 *
 * Boundary effects can cost the window a leading line/block, never the tail —
 * and the tail is all deriveThinkingTail keeps. When the window sanitizes to
 * less than the caller needs (e.g. a closed fence longer than the window ate
 * most of it), deriveThinkingTail grows the window and retries, so the result
 * always matches the full scan; the growth loop only triggers on code-heavy
 * tails and degrades, at worst, to the old full-buffer scan.
 */
function sanitizeThinkingTailWindow(raw: string, windowChars: number): string {
	if (raw.length <= windowChars) {
		return sanitizeThinkingText(raw);
	}
	const indices = getFenceIndices(raw);
	// Effective end of visible text: an odd marker count means the last ```
	// opened a fence that never closed — nothing after it is shown.
	const end = indices.length % 2 === 1 ? indices[indices.length - 1] : raw.length;
	const start = Math.max(0, end - windowChars);
	let window = raw.slice(start, end);
	if (start > 0) {
		if (countFencesBefore(indices, start) % 2 === 1) {
			// Window starts inside a fenced block: drop through its closing ```.
			const close = window.indexOf("```");
			if (close === -1) {
				return "";
			}
			window = window.slice(close + 3);
		} else if (raw[start - 1] !== "\n") {
			// Mid-line cut: drop the partial first line so `^\s*#`/bullet
			// stripping can't misread a mid-line fragment as a line marker. A
			// single line longer than the window keeps the raw cut (cosmetic).
			const firstNewline = window.indexOf("\n");
			if (firstNewline !== -1) {
				window = window.slice(firstNewline + 1);
			}
		}
	}
	return sanitizeThinkingText(window);
}

/**
 * Extract the trailing, currently-live edge of accumulated thinking text as a
 * single dense line: sanitizes the raw text (only the trailing
 * `SANITIZE_WINDOW_CHARS` — see sanitizeThinkingTailWindow), then — if it
 * overflows `maxWidth` — cuts to the last `maxWidth` characters, backs off to
 * the next word boundary so the visible fragment never opens mid-word, and
 * prefixes an ellipsis to mark the truncation. Returns "" for
 * empty/whitespace-only input or a non-positive width. Pure: no clock, no I/O
 * — safe to unit test directly (the internal fence-scan memo only caches; it
 * never changes a result). `windowChars` is parameterized for tests.
 */
export function deriveThinkingTail(
	rawAccumulatedText: string,
	maxWidth: number,
	windowChars: number = SANITIZE_WINDOW_CHARS,
): string {
	if (!rawAccumulatedText || maxWidth <= 0) return "";
	let window = Math.max(1, windowChars);
	let sanitized = sanitizeThinkingTailWindow(rawAccumulatedText, window);
	// A tail longer than maxWidth is guaranteed to match the full scan (the
	// truncation below only reads the trailing chars, which windowing preserves
	// verbatim). A shorter one may have lost pre-window prose to a fence/cut at
	// the boundary — grow the window until the tail is satisfied or the window
	// covers the whole buffer (== the full scan, the pre-windowing behavior).
	while (sanitized.length <= maxWidth && window < rawAccumulatedText.length) {
		window *= 4;
		sanitized = sanitizeThinkingTailWindow(rawAccumulatedText, window);
	}
	if (!sanitized) return "";
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
