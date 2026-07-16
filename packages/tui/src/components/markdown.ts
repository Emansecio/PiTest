import { Marked, type Token, Tokenizer, type Tokens, type TokensList } from "marked";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import { applyBackgroundToLine, visibleWidth, wrapTextWithAnsi } from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

// Hard cap on block-render recursion depth (nested blockquotes / lists). marked
// nests blockquote tokens by `>`-prefix depth and list tokens by indentation, so
// untrusted/streamed content (pasted text, model output) can drive renderToken/
// renderList recursion arbitrarily deep and throw RangeError: Maximum call stack
// size exceeded. That throw is caught by TUI.doRender(), which retries render —
// but the offending markdown stays in the tree, so every retry re-throws and the
// UI wedges in a render-fail loop. Real markdown nests only a handful of levels,
// so capping here is output-identical for all realistic input. The cap also bounds
// the multiplicative cost of nested blockquote border-wrapping (each level re-wraps
// its children), so it is deliberately modest rather than near the raw stack limit.
// Past the cap we stop descending and emit the remaining raw token text instead.
const MAX_BLOCK_RENDER_DEPTH = 24;

class StrictStrikethroughTokenizer extends Tokenizer {
	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

/**
 * Whether a lexed token array carries any resolved reference-link definitions.
 * marked attaches a `links` map (def label → href/title) to the TokensList it
 * returns from lexer(); a non-empty map means inline rendering depends on
 * document-wide def resolution, which a tail-only re-lex cannot reproduce.
 */
function hasLinkDefs(tokens: Token[]): boolean {
	const links = (tokens as Token[] & { links?: TokensList["links"] }).links;
	return links !== undefined && Object.keys(links).length > 0;
}

function applyTextWithNewlines(text: string, applyText: (t: string) => string): string {
	if (!text.includes("\n")) return applyText(text);
	return text
		.split("\n")
		.map((segment) => applyText(segment))
		.join("\n");
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new StrictStrikethroughTokenizer(),
});

/** Result of scanning a text for ``` fence markers: total count plus the loop's exit state. */
interface FenceScanState {
	count: number;
	// Position from which the next `indexOf("```", searchPos)` should resume. This
	// is exactly the loop-internal cursor at the point the scan stopped (either
	// last-match-index + 3, or the initial 0 if there was no match yet) — NOT
	// text.length. Preserving this (rather than restarting at text.length) is what
	// keeps a resumed scan's 3-byte skip alignment identical to a from-scratch scan.
	searchPos: number;
}

/**
 * Scan text for ``` fence markers starting at fromPos, continuing the loop
 * invariant of hasOpenCodeFence: each match advances the cursor by 3 (the fence
 * length) before searching again, never by more. Returns the total match count
 * found in this scan plus the resulting resume cursor.
 */
function scanFences(text: string, fromPos: number): FenceScanState {
	let count = 0;
	let idx = text.indexOf("```", fromPos);
	let searchPos = fromPos;
	while (idx !== -1) {
		count++;
		searchPos = idx + 3;
		idx = text.indexOf("```", searchPos);
	}
	return { count, searchPos };
}

/**
 * True when the buffer ends with an unclosed fenced code block (odd ``` count).
 * Exported for test use as the full-scan oracle that
 * Markdown#hasOpenCodeFenceIncremental must always agree with.
 */
export function hasOpenCodeFence(text: string): boolean {
	return scanFences(text, 0).count % 2 === 1;
}

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	/** Optional H1-specific styling (defaults to `heading` when omitted). */
	heading1?: (text: string) => string;
	/** Optional H2-specific styling (defaults to bold `heading` when omitted). */
	heading2?: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	/** Optional styling for table border glyphs. */
	tableBorder?: (text: string) => string;
	/** Optional styling for the language label of a code block (defaults to `codeBlockBorder` when omitted). */
	codeBlockLang?: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
	/** Blank lines between top-level blocks. Default 1. */
	blockSpacing?: number;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	// Per-top-level-token final lines, keyed by (width, nextTokenType, raw).
	// Persists across setText/invalidate so streaming re-renders only rebuild
	// the trailing (changed) token. Self-prunes: each render keeps only the
	// tokens currently present.
	private tokenLineCache?: Map<string, string[]>;
	// Cached default inline style context (invalidated alongside other caches).
	private cachedDefaultInlineStyleContext?: InlineStyleContext;
	// Incremental-lexing state. Tracks the last successfully lexed buffer so that
	// append-only streaming (setText with a growing prefix) can re-lex only the
	// trailing region instead of the whole document. NOT cleared by invalidate()
	// — these are the incremental baseline, replaced wholesale after each render.
	// When any guard in lexTokens() fails, the path falls back to a full lex and
	// resets this baseline, so the output is always byte-identical to a full lex.
	private lastRawText?: string;
	private lastNormalizedText?: string;
	private lastTokens?: Token[];
	// Test-only counter: number of renders whose lex took the incremental tail
	// path (vs a full re-lex). Exposed via _incrementalLexCount() for the
	// equivalence suite to confirm the fast path is actually exercised.
	private incrementalLexCount = 0;
	// Cached concatenation of every "kept" (stable-prefix) token's `.raw` for the
	// incremental tail-lex. Without this, tryIncrementalLex rebuilds this string
	// from scratch every streamed frame — O(document) per frame, i.e. O(n²) per
	// message. The kept prefix only grows (tokens graduate out of the tail as
	// `kept = prev.slice(0, -2)`), and those prefix tokens are the SAME object
	// instances frame-to-frame (the previous frame's merged array becomes this
	// frame's prev — see lexTokens()/lastTokens). So we cache the concatenation and
	// extend it by only the newly-graduated tokens' raw. `incrLexStableLastToken`
	// anchors the cache to a token identity: a full lex (or any fallback) produces
	// fresh token objects, so the identity check misses and the cache is rebuilt
	// from scratch — no explicit invalidation is required beyond that (the full-lex
	// path and freeze() reset it defensively). `incrLexStableCount` is how many
	// leading kept tokens `incrLexStableRaw` covers.
	private incrLexStableRaw?: string;
	private incrLexStableCount = 0;
	private incrLexStableLastToken?: Token;
	// Table cell measurement cache: cellText (already-rendered, ANSI included) ->
	// { natural: visibleWidth(cellText), minWord: getLongestWordWidth(cellText, 30) }.
	// renderTable's maxUnbrokenWordWidth is always 30, so it is not part of the
	// key. Keyed by rendered text (not raw token), so a hit is valid regardless
	// of width/theme/token-identity churn. Like tokenLineCache, this is NOT
	// cleared by invalidate() — invalidate() runs on every setText(), i.e. every
	// streamed chunk, and the whole point of this cache is that ~99% of a
	// table's cells are byte-identical chunk-to-chunk, so wiping it per-chunk
	// would defeat the optimization entirely. It self-bounds via the size cap
	// below instead.
	private cellMeasureCache = new Map<string, { natural: number; minWord: number }>();
	// Test-only counter: cellMeasureCache hits. Exposed via
	// _cellMeasureCacheHitCount() so the table-caching regression test can
	// confirm unchanged cells actually hit the cache on a re-render (vs merely
	// producing the same output some other way).
	private cellMeasureCacheHits = 0;
	// Table cell wrap cache: `${columnWidth} ${cellText}` -> wrapTextWithAnsi(...)
	// result. CONTRACT: callers must treat the returned array as read-only — it is
	// shared across renders and mutating it would corrupt future cache hits.
	// Same not-cleared-by-invalidate() reasoning as cellMeasureCache above.
	private cellWrapCache = new Map<string, string[]>();
	// Cache size above which we drop the whole cache rather than track LRU/size —
	// real tables never approach this many distinct cell renders per session.
	private static readonly MAX_CELL_CACHE_ENTRIES = 4096;
	// Incremental open-code-fence state, tracked independently of the lex baseline
	// (lastNormalizedText etc.) so it stays correct regardless of tokenLineCache/
	// lex fallback ordering. lastFenceText is the exact string the count/searchPos
	// describe; on an append we resume scanFences from lastFenceSearchPos instead
	// of re-scanning the whole buffer. Any non-append change forces a full rescan.
	private lastFenceText?: string;
	private lastFenceCount = 0;
	private lastFenceSearchPos = 0;
	// Memoizes the tokenLineCache cacheKey per token OBJECT (not per raw string).
	// tryIncrementalLex reuses stable-prefix token objects across renders, so the
	// same object typically needs the same key rebuilt every render even though
	// only token.raw (never mutated after lex) actually determines the bulk of
	// the string — the (width, nextTokenType, deferCodeHighlight) triple is what
	// changes. Recomputing the key string re-hashes token.raw (which can be many
	// KB for a code block) on every render; caching it per-object means the raw
	// is only ever concatenated+hashed once per distinct (token, width, next,
	// defer) combination. A WeakMap needs no pruning/invalidate() clearing: it is
	// keyed by object identity, dead tokens are GC'd with it, and the key format
	// doesn't depend on theme (which invalidate() resets via tokenLineCache).
	private tokenKeyCache = new WeakMap<Token, { width: number; next: string; defer: boolean; key: string }>();
	// Per-line memo for the open-code-fence body while highlight.js is deferred
	// (see deferCodeHighlight in renderToken's "code" case): keyed by
	// `${contentWidth} ${codeLine}` -> the FINAL (styled + wrapped) lines for
	// that source line. The fence body is append-only until it closes, so each
	// earlier line's styled+wrapped output is stable across streamed deltas —
	// without this, the code branch below (plus buildTokenLines' wrap pass)
	// would re-style and re-wrap the whole accumulated body every frame: O(L)
	// per frame, O(L^2) over a fence of L lines. Cleared whenever no fence is
	// open in the current render (see render()'s deferHighlightCodeIdx check)
	// to bound memory and because a later, different fence's lines shouldn't
	// collide with stale entries. Never consulted on the closed-fence
	// (highlightCode) path, so the optimization can only affect intermediate
	// streaming frames, never the final rendered output. If code-line wrap
	// logic ever gains new inputs (e.g. a soft-wrap indicator), fold them
	// into the key.
	private deferredCodeLineCache = new Map<string, string[]>();

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
	}

	setText(text: string): void {
		if (text === this.text) return;
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.cachedDefaultInlineStyleContext = undefined;
	}

	/**
	 * Release the streaming/lexing scratch caches once this message has settled
	 * (no longer being streamed), keeping only the final render cache
	 * (cachedText/cachedWidth/cachedLines). For a long session these per-message
	 * caches — the lex baseline (lastTokens/lastNormalizedText), the per-token line
	 * cache, the table cell measure/wrap caches (up to MAX_CELL_CACHE_ENTRIES
	 * each), the deferred code-line cache and the incremental stableRaw/fence state
	 * — pin roughly 3-4× the transcript text for the whole session, even though a
	 * settled message only ever re-renders as a pure cache hit (render()'s
	 * cachedText===text && cachedWidth===width fast path) or, at worst, a one-off
	 * full re-lex on resize.
	 *
	 * Fully recoverable: every dropped field is read through an `undefined`/empty
	 * guard, so a later setText() (edited message) or width change simply falls back
	 * to a full lex and repopulates — see normalizeIncrementally(), tryIncrementalLex()
	 * guard (a), hasOpenCodeFenceIncremental(), and the tokenLineCache lookup in
	 * render(). Idempotent.
	 */
	freeze(): void {
		// Already frozen (streaming caches released and not repopulated since a full
		// re-lex): nothing to do. Keeps the per-settled-frame re-invocation from the
		// owning component cheap and allocation-free.
		if (this.lastTokens === undefined && this.tokenLineCache === undefined) {
			return;
		}
		this.lastRawText = undefined;
		this.lastNormalizedText = undefined;
		this.lastTokens = undefined;
		this.tokenLineCache = undefined;
		this.cellMeasureCache.clear();
		this.cellWrapCache.clear();
		this.deferredCodeLineCache.clear();
		// Drop the per-token key memo by swapping in a fresh WeakMap (its keys are
		// the now-released token objects; a new map lets them be collected).
		this.tokenKeyCache = new WeakMap();
		// Incremental open-code-fence tracker.
		this.lastFenceText = undefined;
		this.lastFenceCount = 0;
		this.lastFenceSearchPos = 0;
		// Incremental stableRaw cache (see field docs).
		this.incrLexStableRaw = undefined;
		this.incrLexStableCount = 0;
		this.incrLexStableLastToken = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);

		// Don't render anything if there's no actual text
		if (!this.text || this.text.trim() === "") {
			const result: string[] = [];
			// Update cache
			this.cachedText = this.text;
			this.cachedWidth = width;
			this.cachedLines = result;
			return result;
		}

		// Replace tabs with 3 spaces for consistent rendering. During append-only
		// streaming this reuses the previously normalized prefix (tab→spaces is a
		// char-local, stateless substitution) and only normalizes the new suffix.
		const normalizedText = this.normalizeIncrementally();

		// Parse markdown to HTML-like tokens. lexTokens() re-lexes only the trailing
		// region when it is provably safe (see its guards); otherwise it performs a
		// full lex. Either way the result is byte-identical to lexer(normalizedText).
		const tokens = this.lexTokens(normalizedText);

		// Build the final lines for each top-level token (renderToken → wrap →
		// margins/bg) and cache them keyed by (width, nextTokenType, token
		// source). renderToken is pure for top-level tokens, and wrap/margins
		// are per-line independent, so this is byte-identical to the previous
		// flat pipeline. During streaming, only the trailing (mutating) token
		// misses the cache — the old code re-lexed AND re-rendered the entire
		// buffer on every appended token (O(n²) per streamed message).
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;

		// The per-token line cache is keyed by token.raw, which fully determines a
		// token's rendering EXCEPT when reference-link definitions are present:
		// a `[x]` use renders differently once a `[x]: url` def exists elsewhere,
		// while its raw is unchanged. In that (rare) case, do not reuse lines
		// carried over from a previous render — the def map may have changed under
		// an identical raw. Intra-render dedupe (nextTokenCache) stays safe because
		// the def map is constant within a single render. With no defs (the common
		// path, incl. all normal streaming) this is byte- and perf-identical.
		const prevTokenCache = hasLinkDefs(tokens) ? undefined : this.tokenLineCache;
		const nextTokenCache = new Map<string, string[]>();
		const contentLines: string[] = [];

		let deferHighlightCodeIdx = -1;
		if (this.hasOpenCodeFenceIncremental(normalizedText)) {
			for (let j = tokens.length - 1; j >= 0; j--) {
				if (tokens[j]?.type === "code") {
					deferHighlightCodeIdx = j;
					break;
				}
			}
		}
		// No open fence this render: nothing can hit deferredCodeLineCache, so
		// drop it (covers the fence closing and the buffer resetting to new text).
		if (deferHighlightCodeIdx === -1 && this.deferredCodeLineCache.size > 0) {
			this.deferredCodeLineCache.clear();
		}

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextTokenType = tokens[i + 1]?.type;
			const deferCodeHighlight = i === deferHighlightCodeIdx;
			const cacheKey = this.getTokenCacheKey(token, width, nextTokenType, deferCodeHighlight);
			let tokenLines = prevTokenCache?.get(cacheKey) ?? nextTokenCache.get(cacheKey);
			if (!tokenLines) {
				tokenLines = this.buildTokenLines(
					token,
					contentWidth,
					width,
					nextTokenType,
					leftMargin,
					rightMargin,
					bgFn,
					deferCodeHighlight,
				);
			}
			nextTokenCache.set(cacheKey, tokenLines);
			for (const line of tokenLines) {
				contentLines.push(line);
			}
		}
		this.tokenLineCache = nextTokenCache;

		// Add top/bottom padding (empty lines).
		// No background: emit "" (same rule as Text/TruncatedText — no trailing-space pad without bgFn).
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(" ".repeat(width), width, bgFn) : "";
			emptyLines.push(line);
		}

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);

		// Update cache
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;

		return result.length > 0 ? result : [""];
	}

	/** Test-only: count of renders that used the incremental tail-lex path. */
	_incrementalLexCount(): number {
		return this.incrementalLexCount;
	}

	/** Test-only: cumulative cellMeasureCache hit count (see getCellMeasurements). */
	_cellMeasureCacheHitCount(): number {
		return this.cellMeasureCacheHits;
	}

	/**
	 * Normalize this.text (tab → 3 spaces) reusing the previously normalized
	 * prefix when the new text is an append of the last one. Tab expansion is a
	 * char-local, stateless substitution, so normalizing only the appended suffix
	 * yields a byte-identical result to normalizing the whole string.
	 */
	private normalizeIncrementally(): string {
		const last = this.lastRawText;
		if (
			last !== undefined &&
			last.length > 0 &&
			this.lastNormalizedText !== undefined &&
			this.text.startsWith(last)
		) {
			const delta = this.text.slice(last.length);
			return this.lastNormalizedText + delta.replace(/\t/g, "   ");
		}
		return this.text.replace(/\t/g, "   ");
	}

	/**
	 * True when normalizedText ends with an unclosed fenced code block (odd ```
	 * count), computed incrementally when possible.
	 *
	 * hasOpenCodeFence's `indexOf("```", idx+3)` loop is strictly left-to-right
	 * and deterministic: once it has scanned a prefix, every match position and
	 * the loop's resume cursor (searchPos) are fixed facts about that prefix that
	 * cannot change no matter what text follows. So when normalizedText is an
	 * append of the last text this was called with, we resume scanFences from the
	 * saved searchPos over the (small) new suffix — the matches found are exactly
	 * the ones a full scanFences(normalizedText, 0) would find, because the stable
	 * prefix cannot retroactively gain or lose a match, and no match can start
	 * before searchPos (the previous scan already proved no `\`\`\`` exists
	 * between the prior cursor positions and searchPos). Any non-append change
	 * (including a shrink, or a divergent edit) forces a full rescan.
	 */
	private hasOpenCodeFenceIncremental(normalizedText: string): boolean {
		const last = this.lastFenceText;
		let state: FenceScanState;
		if (last !== undefined && normalizedText.startsWith(last) && normalizedText.length >= last.length) {
			state = scanFences(normalizedText, this.lastFenceSearchPos);
			state.count += this.lastFenceCount;
		} else {
			state = scanFences(normalizedText, 0);
		}
		this.lastFenceText = normalizedText;
		this.lastFenceCount = state.count;
		this.lastFenceSearchPos = state.searchPos;
		return state.count % 2 === 1;
	}

	/**
	 * Lex normalizedText into top-level tokens. When the new buffer is a pure
	 * append of the previously lexed one and a series of safety guards all pass,
	 * only the trailing region is re-lexed and concatenated onto the stable
	 * prefix tokens — turning accumulated O(D·L) streaming lexation into ~O(L).
	 *
	 * Every guard failure (and every non-append edit) falls back to a full lex.
	 * The final coverage guard verifies that the concatenated token.raw exactly
	 * reconstructs normalizedText, so the incremental result is byte-identical to
	 * markdownParser.lexer(normalizedText) in all accepted cases.
	 */
	private lexTokens(normalizedText: string): Token[] {
		const incremental = this.tryIncrementalLex(normalizedText);
		if (incremental) {
			this.incrementalLexCount++;
			this.lastRawText = this.text;
			this.lastNormalizedText = normalizedText;
			this.lastTokens = incremental;
			return incremental;
		}

		// marked's blockquote/list block tokenizers recurse by nesting depth, so a
		// pathologically nested document (thousands of `>`/indent levels, easily
		// produced by a paste or a runaway model stream) can throw RangeError before
		// rendering even begins. Catch it and fall back to a single plain-text token
		// so the document still renders (un-formatted) instead of wedging the TUI in
		// a render-fail retry loop. Realistic documents never reach this path.
		let tokens: Token[];
		try {
			tokens = markdownParser.lexer(normalizedText);
		} catch {
			tokens = [{ type: "text", raw: normalizedText, text: normalizedText } as Token];
		}
		this.lastRawText = this.text;
		this.lastNormalizedText = normalizedText;
		this.lastTokens = tokens;
		// Full lex swapped in fresh token objects, so the stableRaw cache's identity
		// anchor no longer matches; reset it (the identity check would catch this
		// anyway, but resetting keeps the invariant explicit and cheap).
		this.incrLexStableRaw = undefined;
		this.incrLexStableCount = 0;
		this.incrLexStableLastToken = undefined;
		return tokens;
	}

	/**
	 * Attempt the incremental tail re-lex. Returns the merged token array on
	 * success, or undefined to signal the caller to fall back to a full lex.
	 */
	private tryIncrementalLex(normalizedText: string): Token[] | undefined {
		const prev = this.lastTokens;
		const prevNormalized = this.lastNormalizedText;
		// Guard (a): need a previous lex, a pure append, and enough stable tokens
		// that discarding the trailing two still leaves a prefix to keep.
		if (!prev || prevNormalized === undefined || prev.length < 3) {
			return undefined;
		}
		if (!normalizedText.startsWith(prevNormalized) || normalizedText.length === prevNormalized.length) {
			return undefined;
		}

		// Guard (b): discard the last two tokens. The final token may be "open"
		// (still being streamed) and the penultimate is often a `space` that can
		// fuse blocks (e.g. tight→loose list promotion when a new item arrives).
		const kept = prev.slice(0, prev.length - 2);
		if (kept.length === 0) {
			return undefined;
		}

		// Guard (e): the last kept token must not be a container that can absorb
		// following content via lazy continuation or looseness changes. Discarding
		// the trailing two tokens already removes the streaming target, so what
		// remains here is a structurally settled boundary for the allowed types.
		const lastKept = kept[kept.length - 1];
		if (
			lastKept.type === "list" ||
			lastKept.type === "table" ||
			lastKept.type === "blockquote" ||
			lastKept.type === "html"
		) {
			return undefined;
		}

		// Concatenate the kept tokens' raw. On the common streaming path we extend a
		// cached prefix by only the tokens that graduated out of the tail since the
		// last call, instead of re-concatenating the whole document. The cache is
		// anchored to a token identity: the kept prefix reuses the same token objects
		// frame-to-frame (previous merged → this prev), so a matching boundary
		// identity proves the cached prefix is still the same tokens; any full lex /
		// fallback swaps in fresh objects and misses, forcing a from-scratch rebuild.
		let stableRaw: string;
		let verifiedPrefixLen: number;
		if (
			this.incrLexStableRaw !== undefined &&
			this.incrLexStableCount > 0 &&
			this.incrLexStableCount <= kept.length &&
			kept[this.incrLexStableCount - 1] === this.incrLexStableLastToken
		) {
			// Cache hit: the first incrLexStableCount kept tokens are the same
			// instances that produced incrLexStableRaw, which was verified as a prefix
			// of the previous normalized text. Guard (a) above already confirmed
			// normalizedText.startsWith(prevNormalized), so that cached prefix is
			// still a prefix of normalizedText and needs no re-check — only the newly
			// appended segment is verified below (from verifiedPrefixLen onward).
			stableRaw = this.incrLexStableRaw;
			verifiedPrefixLen = this.incrLexStableRaw.length;
			for (let i = this.incrLexStableCount; i < kept.length; i++) {
				stableRaw += kept[i].raw;
			}
		} else {
			// Cache miss (first append after a full lex, or a reset): concatenate the
			// full prefix and verify the whole thing, exactly as the original did.
			stableRaw = "";
			verifiedPrefixLen = 0;
			for (const token of kept) {
				stableRaw += token.raw;
			}
		}
		// The kept raw must be an exact prefix of the new normalized text, otherwise
		// the structure shifted under us and the tail offset would be wrong. Only the
		// not-yet-verified suffix is checked here (the cached prefix is guaranteed to
		// match — see above); on a cache miss verifiedPrefixLen is 0, so this is the
		// original full startsWith.
		if (!normalizedText.startsWith(stableRaw.slice(verifiedPrefixLen), verifiedPrefixLen)) {
			return undefined;
		}

		const tail = normalizedText.slice(stableRaw.length);
		// marked's blockquote/list tokenizers recurse by nesting depth, so a
		// pathologically nested tail can throw RangeError. Fall back to the full
		// (also-guarded) lex path rather than propagating the throw.
		let tailTokens: Token[];
		try {
			tailTokens = markdownParser.lexer(tail);
		} catch {
			return undefined;
		}

		// Guard (d): reference-link definitions resolve across the whole document
		// (a def can change inline rendering of a use anywhere, in both directions).
		// If either side carries link defs, or the tail introduces a def line, the
		// tail-only lex cannot see the cross-region relationship → full lex.
		if (hasLinkDefs(prev) || hasLinkDefs(tailTokens) || /^\s{0,3}\[[^\]]+\]:/m.test(tail)) {
			return undefined;
		}

		const merged: Token[] = kept.concat(tailTokens);

		// Guard (f): cheap structural sanity — the concatenated raw of `merged` must
		// exactly reconstruct normalizedText. The startsWith check above proved
		// normalizedText === stableRaw + tail (tail is its slice at stableRaw.length),
		// so merged-raw === normalizedText iff the tail tokens' raw reconstructs
		// `tail`. Checking only that is O(tail) instead of re-concatenating +
		// comparing the whole O(document) buffer every frame; it is semantically
		// identical to the original coverage guard.
		let tailCoverage = "";
		for (const token of tailTokens) {
			tailCoverage += token.raw;
		}
		if (tailCoverage !== tail) {
			return undefined;
		}

		// Update the stableRaw cache for the next frame's extend path, anchored to
		// the last kept token's identity (see the field docs). kept.length >= 1 here
		// (guarded above), so the anchor token always exists.
		this.incrLexStableRaw = stableRaw;
		this.incrLexStableCount = kept.length;
		this.incrLexStableLastToken = kept[kept.length - 1];

		return merged;
	}

	/**
	 * Compute the tokenLineCache key for a token at a given (width,
	 * nextTokenType, deferCodeHighlight), reusing a memoized key string per
	 * token OBJECT when none of those three inputs changed since the last call
	 * for that object. tryIncrementalLex keeps reusing the same token objects
	 * across renders for the stable prefix, so this avoids re-concatenating (and
	 * lazily re-hashing) token.raw — which can be many KB for a code block —
	 * on every single render. The produced key string is byte-identical to the
	 * inline template it replaces; only its construction is memoized.
	 */
	private getTokenCacheKey(
		token: Token,
		width: number,
		nextTokenType: string | undefined,
		deferCodeHighlight: boolean,
	): string {
		const next = nextTokenType ?? "";
		const cached = this.tokenKeyCache.get(token);
		if (cached && cached.width === width && cached.next === next && cached.defer === deferCodeHighlight) {
			return cached.key;
		}
		const key = `${width}\u0000${next}\u0000${deferCodeHighlight ? 1 : 0}\u0000${token.raw}`;
		this.tokenKeyCache.set(token, { width, next, defer: deferCodeHighlight, key });
		return key;
	}

	/**
	 * Render a single top-level token to its final padded/background-applied
	 * lines. Pure for a given (token, width, nextTokenType) plus the instance
	 * theme/style, which is what makes per-token caching in render() sound.
	 */
	private buildTokenLines(
		token: Token,
		contentWidth: number,
		width: number,
		nextTokenType: string | undefined,
		leftMargin: string,
		rightMargin: string,
		bgFn: ((text: string) => string) | undefined,
		deferCodeHighlight = false,
	): string[] {
		const renderedLines = this.renderToken(token, contentWidth, nextTokenType, undefined, 0, deferCodeHighlight);

		// Wrap lines (NO padding, NO background yet). While a code fence is open
		// (deferCodeHighlight), renderToken's "code" case already wraps every line
		// it emits (border/rule lines are always exactly contentWidth already; the
		// lang line and each code line are wrapped there, memoized per source line)
		// — skip this pass entirely so we don't re-wrap the whole accumulated body
		// on every streamed frame. deferCodeHighlight is only ever true for the
		// single top-level "code" token being streamed (see render()'s
		// deferHighlightCodeIdx), so this can't affect neighboring/sibling tokens.
		const wrappedLines: string[] = [];
		if (deferCodeHighlight) {
			for (const line of renderedLines) {
				wrappedLines.push(line);
			}
		} else {
			for (const line of renderedLines) {
				if (isImageLine(line)) {
					wrappedLines.push(line);
				} else {
					for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
						wrappedLines.push(wrappedLine);
					}
				}
			}
		}

		// Add margins and background to each wrapped line
		const out: string[] = [];
		for (const line of wrappedLines) {
			if (isImageLine(line)) {
				out.push(line);
				continue;
			}

			const lineWithMargins = leftMargin + line + rightMargin;

			if (bgFn) {
				out.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
			} else {
				// No background: emit the line as-is without right-padding.
				// Mirrors Text/TruncatedText, which deliberately skip trailing spaces
				// when no bgFn is set (background extends only via the color function).
				out.push(lineWithMargins);
			}
		}
		return out;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		if (!this.cachedDefaultInlineStyleContext) {
			this.cachedDefaultInlineStyleContext = {
				applyText: (text: string) => this.applyDefaultStyle(text),
				stylePrefix: this.getDefaultStylePrefix(),
			};
		}
		return this.cachedDefaultInlineStyleContext;
	}

	/**
	 * Push the configured number of blank lines between two top-level blocks.
	 * Default (theme.blockSpacing undefined) is one blank line, matching the
	 * historical single `lines.push("")` behavior byte-for-byte.
	 */
	private pushBlockSpacing(lines: string[]): void {
		const count = Math.max(0, this.theme.blockSpacing ?? 1);
		for (let i = 0; i < count; i++) {
			lines.push("");
		}
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
		depth = 0,
		deferCodeHighlight = false,
	): string[] {
		const lines: string[] = [];

		// Recursion-depth guard. Block-level tokens (blockquote, list) recurse via
		// renderToken/renderList; pathologically nested untrusted input would
		// otherwise overflow the stack. Past the cap, stop descending and emit the
		// remaining raw token text so the document still renders (just un-nested).
		if (depth > MAX_BLOCK_RENDER_DEPTH) {
			let rawText: string | undefined;
			if ("raw" in token && typeof token.raw === "string") {
				rawText = token.raw;
			} else if ("text" in token && typeof token.text === "string") {
				rawText = token.text;
			}
			if (rawText !== undefined && rawText.length > 0) {
				lines.push(this.applyDefaultStyle(rawText));
			}
			return lines;
		}

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1 && this.theme.heading1) {
					headingStyleFn = (text: string) => this.theme.heading1!(text);
				} else if (headingLevel === 2 && this.theme.heading2) {
					headingStyleFn = (text: string) => this.theme.heading2!(text);
				} else if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				// H3+ no longer leaks the literal "### " prefix; bold heading color + the
				// H2 accent bar being absent is enough to distinguish levels.
				lines.push(headingText);
				if (nextTokenType && nextTokenType !== "space") {
					this.pushBlockSpacing(lines); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					this.pushBlockSpacing(lines);
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "code": {
				// Open frame: top/bottom rules fold into the left gutter only (no right
				// vertical), so the corners never dangle over the unboxed body lines.
				const gutter = this.theme.codeBlockBorder("│ ");
				const indent = this.theme.codeBlockIndent ?? "";
				const prefix = gutter + indent;
				const rule = "─".repeat(Math.max(0, width - 1));
				lines.push(this.theme.codeBlockBorder(`╭${rule}`));
				if (typeof token.lang === "string" && token.lang.length > 0) {
					const langStyle = this.theme.codeBlockLang ?? this.theme.codeBlockBorder;
					const langLine = prefix + langStyle(token.lang);
					if (deferCodeHighlight) {
						// buildTokenLines skips its own wrap pass for this token while the
						// fence is open, so wrap eagerly here. Cheap (at most one lang line
						// per render) — not worth memoizing.
						for (const wrappedLine of wrapTextWithAnsi(langLine, width)) {
							lines.push(wrappedLine);
						}
					} else {
						lines.push(langLine);
					}
				}
				if (this.theme.highlightCode && !deferCodeHighlight) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(prefix + hlLine);
					}
				} else if (deferCodeHighlight) {
					// The fence is open: defer highlight.js and split code by newlines,
					// styling + wrapping each line, memoized per (contentWidth, codeLine).
					// The body is append-only until the fence closes, so an earlier line's
					// styled+wrapped output never changes as later lines stream in. `width`
					// here IS contentWidth (see buildTokenLines' call above).
					// buildTokenLines skips its own wrap pass whenever deferCodeHighlight is
					// true, so this branch must fully wrap before pushing (unlike the plain
					// non-deferred split/style branch below, which leaves wrapping to
					// buildTokenLines as before).
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						const cacheKey = `${width} ${codeLine}`;
						let wrapped = this.deferredCodeLineCache.get(cacheKey);
						if (!wrapped) {
							const styled = prefix + this.theme.codeBlock(codeLine);
							wrapped = wrapTextWithAnsi(styled, width);
							this.deferredCodeLineCache.set(cacheKey, wrapped);
						}
						for (const wrappedLine of wrapped) {
							lines.push(wrappedLine);
						}
					}
				} else {
					// No highlightCode theme configured at all (and no fence is being
					// deferred): split code by newlines and style each line. Wrapping is
					// left to buildTokenLines, same as before this change.
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(prefix + this.theme.codeBlock(codeLine));
					}
				}
				lines.push(this.theme.codeBlockBorder(`╰${rule}`));
				if (nextTokenType && nextTokenType !== "space") {
					this.pushBlockSpacing(lines); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext, depth);
				// Push via loop (not spread): deeply nested input can make this array
				// large enough to exceed the spread argument-count limit (RangeError).
				for (const line of listLines) {
					lines.push(line);
				}
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				for (const line of tableLines) {
					lines.push(line);
				}
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = Math.max(1, width - 2);

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					const childLines = this.renderToken(
						quoteToken,
						quoteContentWidth,
						nextQuoteToken?.type,
						quoteInlineStyleContext,
						depth + 1,
					);
					// Push via loop (not spread): deeply nested blockquotes can make this
					// array exceed the spread argument-count limit (RangeError).
					for (const line of childLines) {
						renderedQuoteLines.push(line);
					}
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					this.pushBlockSpacing(lines); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.max(1, width))));
				if (nextTokenType && nextTokenType !== "space") {
					this.pushBlockSpacing(lines); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;

		for (const token of tokens) {
			switch (token.type) {
				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(token.text, applyText);
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result += this.theme.code(token.text) + stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${token.href})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(token.raw, applyText);
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(token.text, applyText);
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(
		token: Tokens.List,
		depth: number,
		width: number,
		styleContext?: InlineStyleContext,
		renderDepth = 0,
	): string[] {
		const lines: string[] = [];

		// Recursion-depth guard shared with renderToken (see MAX_BLOCK_RENDER_DEPTH).
		// `depth` is the visual indentation level; `renderDepth` is the actual
		// renderToken/renderList call-stack depth, which is what we must bound.
		// Past the cap, emit the list's raw source instead of descending further.
		if (renderDepth > MAX_BLOCK_RENDER_DEPTH) {
			const rawText = typeof token.raw === "string" ? token.raw : undefined;
			if (rawText && rawText.length > 0) {
				lines.push(this.applyDefaultStyle(rawText));
			}
			return lines;
		}

		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const bullet = token.ordered ? `${startNumber + i}. ` : "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					const nestedLines = this.renderList(
						itemToken as Tokens.List,
						depth + 1,
						width,
						styleContext,
						renderDepth + 1,
					);
					// Push via loop (not spread): deeply nested lists can make this array
					// exceed the spread argument-count limit (RangeError).
					for (const line of nestedLines) {
						lines.push(line);
					}
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext, renderDepth + 1);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, maxWidth));
	}

	/**
	 * Look up (or compute + cache) a cell's natural visible width and its
	 * longest-unbroken-word width (capped at maxUnbrokenWordWidth=30, the only
	 * value ever passed here, so it is not part of the key). Keyed by the
	 * already-rendered cellText, which fully determines both measurements.
	 * During streaming, ~99% of a table's cells are byte-identical across
	 * chunks, so this turns an O(R*C) re-measure per chunk into a cache hit.
	 */
	private getCellMeasurements(cellText: string): { natural: number; minWord: number } {
		const cached = this.cellMeasureCache.get(cellText);
		if (cached) {
			this.cellMeasureCacheHits++;
			return cached;
		}
		if (this.cellMeasureCache.size >= Markdown.MAX_CELL_CACHE_ENTRIES) {
			this.cellMeasureCache.clear();
		}
		const measurements = {
			natural: visibleWidth(cellText),
			minWord: this.getLongestWordWidth(cellText, 30),
		};
		this.cellMeasureCache.set(cellText, measurements);
		return measurements;
	}

	/**
	 * Look up (or compute + cache) the wrapped lines for a cell at a given
	 * column width. CONTRACT: the returned array is shared with the cache —
	 * callers must never mutate it (push/sort/splice/etc.), only read it.
	 */
	private getCellWrapLines(cellText: string, columnWidth: number): string[] {
		const key = `${columnWidth} ${cellText}`;
		const cached = this.cellWrapCache.get(key);
		if (cached) {
			return cached;
		}
		if (this.cellWrapCache.size >= Markdown.MAX_CELL_CACHE_ENTRIES) {
			this.cellWrapCache.clear();
		}
		const wrapped = this.wrapCellText(cellText, columnWidth);
		this.cellWrapCache.set(key, wrapped);
		return wrapped;
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to a stacked
			// "Header: cell" rendering, one row per group, separated by a blank line.
			const headerTexts = token.header.map((cell) => this.renderInlineTokens(cell.tokens || [], styleContext));
			const fallbackLines: string[] = [];
			for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
				if (rowIndex > 0) {
					fallbackLines.push("");
				}
				const row = token.rows[rowIndex];
				for (let i = 0; i < numCols; i++) {
					const cellText = row[i] ? this.renderInlineTokens(row[i].tokens || [], styleContext) : "";
					const line = `${this.theme.bold(headerTexts[i])}: ${cellText}`;
					for (const wrappedLine of wrapTextWithAnsi(line, availableWidth)) {
						fallbackLines.push(wrappedLine);
					}
				}
			}
			if (nextTokenType && nextTokenType !== "space") {
				this.pushBlockSpacing(fallbackLines);
			}
			return fallbackLines;
		}

		// Calculate natural column widths (what each column needs without constraints).
		// Cache rendered cell text so the sizing pass isn't repeated during output.
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		const headerTexts: string[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			headerTexts[i] = headerText;
			const { natural, minWord } = this.getCellMeasurements(headerText);
			naturalWidths[i] = natural;
			minWordWidths[i] = Math.max(1, minWord);
		}
		const rowTexts: string[][] = [];
		for (const row of token.rows) {
			const rowText: string[] = [];
			rowTexts.push(rowText);
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				rowText[i] = cellText;
				const { natural, minWord } = this.getCellMeasurements(cellText);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, natural);
				minWordWidths[i] = Math.max(minWordWidths[i] || 1, minWord);
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		const tableBorder = this.theme.tableBorder ?? ((text: string) => text);

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(tableBorder(`┌─${topBorderCells.join("─┬─")}─┐`));

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((_cell, i) => {
			return this.getCellWrapLines(headerTexts[i], columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`${tableBorder("│")} ${rowParts.join(` ${tableBorder("│")} `)} ${tableBorder("│")}`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = tableBorder(`├─${separatorCells.join("─┼─")}─┤`);
		lines.push(separatorLine);

		// Render rows with wrapping. Internal separators only appear next to rows
		// that wrapped onto multiple physical lines (the one case where they
		// disambiguate cell boundaries); single-line rows stay separator-free so a
		// simple table doesn't double in height.
		let prevRowWrapped = false;
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const rowCellLines: string[][] = token.rows[rowIndex].map((_cell, i) => {
				return this.getCellWrapLines(rowTexts[rowIndex][i], columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));
			const rowWrapped = rowLineCount > 1;

			if (rowIndex > 0 && (prevRowWrapped || rowWrapped)) {
				lines.push(separatorLine);
			}

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`${tableBorder("│")} ${rowParts.join(` ${tableBorder("│")} `)} ${tableBorder("│")}`);
			}

			prevRowWrapped = rowWrapped;
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(tableBorder(`└─${bottomBorderCells.join("─┴─")}─┘`));

		if (nextTokenType && nextTokenType !== "space") {
			this.pushBlockSpacing(lines); // Add spacing after table
		}
		return lines;
	}
}
