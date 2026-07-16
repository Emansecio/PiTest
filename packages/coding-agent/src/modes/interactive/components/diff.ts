import { sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@pit/tui";
import * as Diff from "diff";
import { replaceTabs } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { getLanguageFromPath, highlightCode, type ThemeColor, theme } from "../theme/theme.ts";

export type RenderDiffOptions = {
	path?: string;
	lang?: string;
};

type DiffLine = { lineNum: string; content: string };

/**
 * Emphasize an intra-line changed token without video-reverse: bold + the line's
 * own diff color. When `reassertLineColor` is true (legacy solid-tint bodies),
 * re-open the line color after the token so trailing plain text stays tinted.
 * When false (syntax-highlighted bodies), leave the next segment to bring its
 * own ANSI — re-asserting the diff color would wash out following syntax.
 */
function emphasizeToken(value: string, color: ThemeColor, reassertLineColor: boolean): string {
	const token = `\x1b[1m${theme.fg(color, value)}\x1b[22m`;
	if (!reassertLineColor) {
		return token;
	}
	return `${token}${theme.getFgAnsi(color)}`;
}

function formatDiffLine(
	sign: "+" | "-" | " ",
	lineNum: string,
	body: string,
	lineColor: ThemeColor,
	bodyPreColored: boolean,
): string {
	// Keep the padded width from generateDiffString so bodies stay column-aligned
	// across digit-width boundaries in a hunk (99 → 100). The dim number column
	// reads as a stable left gutter; the bold sign sits next to the content it
	// marks. Raw bold codes (not chalk) to match emphasizeToken.
	const numRendered = theme.fg("dim", lineNum);
	const signRendered = sign === " " ? " " : `\x1b[1m${theme.fg(lineColor, sign)}\x1b[22m`;
	// Pre-colored bodies (syntax and/or intra-line emphasis) already carry ANSI;
	// wrapping them in the line tint would clobber syntax colors. Plain bodies
	// still need the line-color wrap so unchanged text before the first
	// emphasizeToken stays tinted.
	const coloredBody = bodyPreColored ? body : theme.fg(lineColor, body);
	const assembled = `${numRendered} ${signRendered} ${coloredBody}`;
	// Syntax-highlighted bodies make +/−/context foregrounds near-identical, so
	// added/removed lines also carry a subtle full-line background — the line
	// itself signals its role, not just the 1-cell sign. Foreground resets
	// (\x1b[39m) inside the body don't touch the background. Optional token:
	// custom themes without it keep the sign-only rendering.
	if (sign !== " ") {
		const bgAnsi = theme.tryGetBgAnsi(sign === "+" ? "toolDiffAddedBg" : "toolDiffRemovedBg");
		if (bgAnsi) {
			return `${bgAnsi}${assembled}\x1b[49m`;
		}
	}
	return assembled;
}

/**
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

function resolveLang(options?: RenderDiffOptions): string | undefined {
	if (options?.lang) return options.lang;
	if (options?.path) return getLanguageFromPath(options.path);
	return undefined;
}

/** Syntax-color a plain segment when lang is known; otherwise return as-is. */
function colorizeSegment(plain: string, lang: string | undefined): string {
	if (!lang || plain.length === 0) return plain;
	return highlightCode(plain, lang)[0] ?? plain;
}

/**
 * Compute word-level diff and emphasize changed tokens with bold + the line's
 * diff color (not video-reverse — see {@link emphasizeToken}).
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from the emphasis to avoid highlighting indentation.
 * Unchanged segments get syntax highlight when `lang` is set.
 */
function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	lang: string | undefined,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);
	const reassert = !lang;

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += lang ? colorizeSegment(leadingWs, lang) : leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += emphasizeToken(value, "toolDiffRemoved", reassert);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += lang ? colorizeSegment(leadingWs, lang) : leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += emphasizeToken(value, "toolDiffAdded", reassert);
			}
		} else {
			const colored = colorizeSegment(part.value, lang);
			removedLine += colored;
			addedLine += colored;
		}
	}

	return { removedLine, addedLine };
}

function pushPlainDiffLine(
	result: string[],
	sign: "+" | "-" | " ",
	line: DiffLine,
	lineColor: ThemeColor,
	lang: string | undefined,
): void {
	const plain = replaceTabs(line.content);
	if (lang) {
		result.push(formatDiffLine(sign, line.lineNum, colorizeSegment(plain, lang), lineColor, true));
	} else {
		result.push(formatDiffLine(sign, line.lineNum, plain, lineColor, false));
	}
}

function pushPairedDiffLines(result: string[], removed: DiffLine, added: DiffLine, lang: string | undefined): void {
	const { removedLine, addedLine } = renderIntraLineDiff(
		replaceTabs(removed.content),
		replaceTabs(added.content),
		lang,
	);
	// With lang the body is fully pre-colored (syntax + emphasis). Without lang,
	// emphasizeToken reasserts the line tint but text before the first changed
	// token still needs formatDiffLine's wrap — so bodyPreColored stays false.
	const preColored = Boolean(lang);
	result.push(formatDiffLine("-", removed.lineNum, removedLine, "toolDiffRemoved", preColored));
	result.push(formatDiffLine("+", added.lineNum, addedLine, "toolDiffAdded", preColored));
}

/**
 * Align a consecutive -/+ hunk: exact matches via diffArrays stay as paired
 * -/+ without word emphasis; equal-count change runs are zip-paired for
 * word-level diff; unequal runs fall back to full-line remove-then-add.
 */
function emitAlignedHunk(
	result: string[],
	removedLines: DiffLine[],
	addedLines: DiffLine[],
	lang: string | undefined,
): void {
	if (removedLines.length === 0 && addedLines.length === 0) return;

	if (removedLines.length === 0) {
		for (const added of addedLines) {
			pushPlainDiffLine(result, "+", added, "toolDiffAdded", lang);
		}
		return;
	}
	if (addedLines.length === 0) {
		for (const removed of removedLines) {
			pushPlainDiffLine(result, "-", removed, "toolDiffRemoved", lang);
		}
		return;
	}

	const parts = Diff.diffArrays(
		removedLines.map((line) => line.content),
		addedLines.map((line) => line.content),
	);

	let remIdx = 0;
	let addIdx = 0;
	let partIdx = 0;

	while (partIdx < parts.length) {
		const part = parts[partIdx];

		if (!part.added && !part.removed) {
			for (let n = 0; n < part.value.length; n++) {
				const removed = removedLines[remIdx++];
				const added = addedLines[addIdx++];
				pushPlainDiffLine(result, "-", removed, "toolDiffRemoved", lang);
				pushPlainDiffLine(result, "+", added, "toolDiffAdded", lang);
			}
			partIdx++;
			continue;
		}

		if (part.removed) {
			const remBatch: DiffLine[] = [];
			while (partIdx < parts.length && parts[partIdx].removed && !parts[partIdx].added) {
				for (let n = 0; n < parts[partIdx].value.length; n++) {
					remBatch.push(removedLines[remIdx++]);
				}
				partIdx++;
			}
			const addBatch: DiffLine[] = [];
			while (partIdx < parts.length && parts[partIdx].added && !parts[partIdx].removed) {
				for (let n = 0; n < parts[partIdx].value.length; n++) {
					addBatch.push(addedLines[addIdx++]);
				}
				partIdx++;
			}

			if (remBatch.length === addBatch.length) {
				for (let n = 0; n < remBatch.length; n++) {
					pushPairedDiffLines(result, remBatch[n], addBatch[n], lang);
				}
			} else {
				for (const removed of remBatch) {
					pushPlainDiffLine(result, "-", removed, "toolDiffRemoved", lang);
				}
				for (const added of addBatch) {
					pushPlainDiffLine(result, "+", added, "toolDiffAdded", lang);
				}
			}
			continue;
		}

		// Standalone added run (no preceding removes in this walk).
		for (let n = 0; n < part.value.length; n++) {
			pushPlainDiffLine(result, "+", addedLines[addIdx++], "toolDiffAdded", lang);
		}
		partIdx++;
	}
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: muted (or syntax when lang is known)
 * - Removed/added lines: diff sign colors; bodies syntax-highlighted when lang
 *   is known, otherwise solid toolDiff tint; word-level bold on aligned pairs
 */
export function renderDiff(diffText: string, options?: RenderDiffOptions): string {
	const lang = resolveLang(options);
	const lines = diffText.split("\n");
	const result: string[] = [];

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			const removedLines: DiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			const addedLines: DiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			emitAlignedHunk(result, removedLines, addedLines, lang);
		} else if (parsed.prefix === "+") {
			pushPlainDiffLine(result, "+", { lineNum: parsed.lineNum, content: parsed.content }, "toolDiffAdded", lang);
			i++;
		} else if (parsed.lineNum.trim() === "" && parsed.content === "...") {
			// Hunk-skip marker (numberless "..." row from generateDiffString):
			// a single dim ellipsis aligned to the body column.
			result.push(`${parsed.lineNum}   ${theme.fg("dim", "…")}`);
			i++;
		} else {
			pushPlainDiffLine(result, " ", { lineNum: parsed.lineNum, content: parsed.content }, "toolDiffContext", lang);
			i++;
		}
	}

	return result.join("\n");
}

// Structural shape of a rendered diff line's gutter, matched against the ANSI-stripped
// text so digit/sign detection isn't thrown off by embedded escape codes: padded line
// number, a space, the sign (or a space for context lines), a space. Shared by every
// line formatDiffLine produces and by the hunk-skip "..." marker, whose blank number
// field and 3-space run before the ellipsis fit the same shape (its "sign" slot is
// itself a space too) — see the "renders the numberless hunk-skip marker" test.
const DIFF_GUTTER_PATTERN = /^(\s*\d*) ([-+ ]) /;

/** Visible-column width of a rendered diff line's number+sign gutter, or 0 for lines
 * that don't have this shape (renderDiff's plain-line fallback for unparseable input). */
function diffLineGutterWidth(line: string): number {
	return DIFF_GUTTER_PATTERN.exec(stripAnsi(line))?.[0].length ?? 0;
}

/**
 * Wrap one rendered diff line (a line from {@link renderDiff}'s output) to `width`,
 * keeping word-wrapped continuations aligned under the body instead of falling back to
 * column 0 — a continuation starting at column 0 is visually indistinguishable from a
 * fresh +/-/context line, and ambiguous which one. Continuation lines get `gutterWidth`
 * spaces of hanging indent and the body re-wraps at the narrower remaining width. ANSI
 * state active at the gutter/body boundary (the +/- background tint, syntax color)
 * carries into the sliced body, and wrapTextWithAnsi's own tracker re-asserts it on
 * each wrapped continuation, so backgrounds don't drop mid-line.
 */
function wrapDiffLine(line: string, width: number): string[] {
	const gutterWidth = diffLineGutterWidth(line);
	if (gutterWidth <= 0 || gutterWidth >= width) {
		return wrapTextWithAnsi(line, width);
	}
	const bodyWidth = width - gutterWidth;
	// +1 past the body's own visible width so a trailing zero-width ANSI code (the
	// closing \x1b[49m background reset, at the very end of the line) is still
	// included — sliceByColumn's range is exclusive of the end column otherwise.
	const bodyLength = Math.max(0, visibleWidth(line) - gutterWidth) + 1;
	const body = sliceByColumn(line, gutterWidth, bodyLength);
	const wrappedBody = wrapTextWithAnsi(body, bodyWidth);
	const gutter = sliceByColumn(line, 0, gutterWidth);
	const indent = " ".repeat(gutterWidth);
	return wrappedBody.map((fragment, i) => (i === 0 ? gutter + fragment : indent + fragment));
}

/**
 * Wrap a full {@link renderDiff} body to `width`, one logical diff line at a time,
 * preserving the number/sign gutter's column alignment on wrapped continuations (see
 * {@link wrapDiffLine}). Dedicated wrap step for the diff body instead of feeding it
 * through the generic Text component's word-wrap, which has no notion of a gutter and
 * lets continuations fall back to column 0.
 */
export function wrapDiffBody(body: string, width: number): string[] {
	if (!body) return [];
	const result: string[] = [];
	for (const line of body.split("\n")) {
		result.push(...wrapDiffLine(line, width));
	}
	return result;
}
