import * as Diff from "diff";
import { replaceTabs } from "../../../core/tools/render-utils.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";

/**
 * Emphasize an intra-line changed token without video-reverse: bold + the line's
 * own diff color, re-asserted after the token so the `\x1b[39m` foreground reset
 * doesn't drop the line color for any trailing context on the same row. Keeps the
 * diff line's background intact (we never touch bg here) and reads as a brighter,
 * heavier token instead of an inverted block.
 */
function emphasizeToken(value: string, color: ThemeColor): string {
	// `\x1b[1m` bold on, colored token, `\x1b[22m` bold off, then re-open the line
	// color so the surrounding unchanged text stays tinted.
	return `\x1b[1m${theme.fg(color, value)}\x1b[22m${theme.getFgAnsi(color)}`;
}

function formatDiffLine(sign: "+" | "-" | " ", lineNum: string, body: string, lineColor: ThemeColor): string {
	// Keep the padded width from generateDiffString so bodies stay column-aligned
	// across digit-width boundaries in a hunk (99 → 100). The dim number column
	// reads as a stable left gutter; the bold sign sits next to the content it
	// marks. Raw bold codes (not chalk) to match emphasizeToken.
	const numRendered = theme.fg("dim", lineNum);
	const signRendered = sign === " " ? " " : `\x1b[1m${theme.fg(lineColor, sign)}\x1b[22m`;
	// Always open the line color around the whole body: intra-line bodies carry
	// emphasizeToken ANSI that re-asserts the line color after each token, but
	// without this wrap the unchanged text BEFORE the first token stays untinted.
	const coloredBody = theme.fg(lineColor, body);
	return `${numRendered} ${signRendered} ${coloredBody}`;
}

/**
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Compute word-level diff and emphasize changed tokens with bold + the line's
 * diff color (not video-reverse — see {@link emphasizeToken}).
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from the emphasis to avoid highlighting indentation.
 */
function renderIntraLineDiff(oldContent: string, newContent: string): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

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
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += emphasizeToken(value, "toolDiffRemoved");
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += emphasizeToken(value, "toolDiffAdded");
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 * - Context lines: dim/gray
 * - Removed lines: red, with bold-emphasized changed tokens
 * - Added lines: green, with bold-emphasized changed tokens
 */
export function renderDiff(diffText: string): string {
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
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
				);

				result.push(formatDiffLine("-", removed.lineNum, removedLine, "toolDiffRemoved"));
				result.push(formatDiffLine("+", added.lineNum, addedLine, "toolDiffAdded"));
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					result.push(formatDiffLine("-", removed.lineNum, replaceTabs(removed.content), "toolDiffRemoved"));
				}
				for (const added of addedLines) {
					result.push(formatDiffLine("+", added.lineNum, replaceTabs(added.content), "toolDiffAdded"));
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			result.push(formatDiffLine("+", parsed.lineNum, replaceTabs(parsed.content), "toolDiffAdded"));
			i++;
		} else if (parsed.lineNum.trim() === "" && parsed.content === "...") {
			// Hunk-skip marker (numberless "..." row from generateDiffString):
			// a single dim ellipsis aligned to the body column.
			result.push(`${parsed.lineNum}   ${theme.fg("dim", "…")}`);
			i++;
		} else {
			// Context line
			result.push(formatDiffLine(" ", parsed.lineNum, replaceTabs(parsed.content), "toolDiffContext"));
			i++;
		}
	}

	return result.join("\n");
}
