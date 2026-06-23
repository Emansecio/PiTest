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
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
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
		this.text = text;
		this.invalidate();
	}

	invalidate(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.cachedDefaultInlineStyleContext = undefined;
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

		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextTokenType = tokens[i + 1]?.type;
			const cacheKey = `${width}\u0000${nextTokenType ?? ""}\u0000${token.raw}`;
			let tokenLines = prevTokenCache?.get(cacheKey) ?? nextTokenCache.get(cacheKey);
			if (!tokenLines) {
				tokenLines = this.buildTokenLines(token, contentWidth, width, nextTokenType, leftMargin, rightMargin, bgFn);
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

		let stableRaw = "";
		for (const token of kept) {
			stableRaw += token.raw;
		}
		// The kept raw must be an exact prefix of the new normalized text, otherwise
		// the structure shifted under us and the tail offset would be wrong.
		if (!normalizedText.startsWith(stableRaw)) {
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

		// Guard (f): cheap structural sanity. If the concatenated raw does not
		// exactly reconstruct the input, the token boundaries diverged from a full
		// lex (e.g. a structural merge the other guards missed) → full lex.
		let coverage = "";
		for (const token of merged) {
			coverage += token.raw;
		}
		if (coverage !== normalizedText) {
			return undefined;
		}

		return merged;
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
	): string[] {
		const renderedLines = this.renderToken(token, contentWidth, nextTokenType);

		// Wrap lines (NO padding, NO background yet)
		const wrappedLines: string[] = [];
		for (const line of renderedLines) {
			if (isImageLine(line)) {
				wrappedLines.push(line);
			} else {
				for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
					wrappedLines.push(wrappedLine);
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
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
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
				const gutter = this.theme.codeBlockBorder("│ ");
				if (typeof token.lang === "string" && token.lang.length > 0) {
					lines.push(gutter + this.theme.codeBlockBorder(token.lang));
				}
				if (this.theme.highlightCode) {
					const highlightedLines = this.theme.highlightCode(token.text, token.lang);
					for (const hlLine of highlightedLines) {
						lines.push(gutter + hlLine);
					}
				} else {
					// Split code by newlines and style each line
					const codeLines = token.text.split("\n");
					for (const codeLine of codeLines) {
						lines.push(gutter + this.theme.codeBlock(codeLine));
					}
				}
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
			const bullet = token.ordered ? `${startNumber + i}. ` : "• ";
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

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints)
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		for (let i = 0; i < numCols; i++) {
			const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
			naturalWidths[i] = visibleWidth(headerText);
			minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
		}
		for (const row of token.rows) {
			for (let i = 0; i < row.length; i++) {
				const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
				naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
				minWordWidths[i] = Math.max(
					minWordWidths[i] || 1,
					this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
				);
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

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[i]);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return this.wrapCellText(text, columnWidths[i]);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			this.pushBlockSpacing(lines); // Add spacing after table
		}
		return lines;
	}
}
