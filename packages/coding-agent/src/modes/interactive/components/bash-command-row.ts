import { truncateToWidth, visibleWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import { expandKeyHint, moreLinesTrailer } from "./tool-activity.ts";

/** Path length past which a leading `cd <path> &&` is shortened in the collapsed
 * row. Short paths are left verbatim. */
const CD_PATH_SHORTEN_THRESHOLD = 24;

/**
 * Shorten a leading `cd <path> && <rest>` so a long absolute path doesn't eat
 * the row and push the actual command off-screen (the common
 * `cd "C:/long/abs/path" && grep …` shape). The path collapses to its last one
 * or two segments (`…/Projeto Fitness`), preserving quotes. Only the collapsed
 * title is touched — expanding (ctrl+o) still shows the verbatim command.
 */
function collapseCdPrefix(line: string): string {
	const m = line.match(/^cd\s+("[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*(.+)$/);
	if (!m) return line;
	const rawPath = m[1] ?? "";
	const rest = m[2] ?? "";
	const quote = rawPath[0] === '"' || rawPath[0] === "'" ? rawPath[0] : "";
	const bare = quote ? rawPath.slice(1, -1) : rawPath;
	if (bare.length <= CD_PATH_SHORTEN_THRESHOLD) return line;
	const segs = bare.split(/[/\\]/).filter(Boolean);
	if (segs.length === 0) return line;
	let tail = segs.slice(-2).join("/");
	if (tail.length > 28) tail = segs[segs.length - 1] ?? tail;
	return `cd ${quote}…/${tail}${quote} && ${rest}`;
}

/**
 * Elide a leading `cd <path> && <rest>` entirely, returning just `<rest>`. The
 * grouped activity row already carries the shell `$` glyph + "Ran" verb, so the
 * `cd …/dir &&` boilerplate only eats width before the command that matters. The
 * verbatim command (cd included) is still one ctrl+o away on expand. No leading
 * `cd … &&` → the line is returned unchanged.
 */
function stripLeadingCd(line: string): string {
	const m = line.match(/^cd\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*(.+)$/);
	return m ? (m[1] ?? line) : line;
}

/**
 * Strip one or more leading `echo <label> &&` diagnostic prefixes agents often
 * prepend before the real command (`echo "=== status ===" && git status …`).
 * Only the collapsed activity title is touched — expand still shows verbatim.
 */
function stripLeadingEcho(line: string): string {
	let current = line;
	while (true) {
		const m = current.match(/^echo\s+(?:"[^"]*"|'[^']*'|[^\s&]+)\s*&&\s*(.+)$/);
		if (!m) break;
		current = m[1] ?? current;
	}
	return current;
}

/** Prepare the first line of a command for a collapsed activity/bash row. */
function prepareBashHead(firstLine: string, opts: { elideCd?: boolean; stripEcho?: boolean }): string {
	let head = firstLine;
	if (opts.stripEcho) head = stripLeadingEcho(head);
	if (opts.elideCd) return stripLeadingCd(head);
	return collapseCdPrefix(head);
}

/**
 * Build a single visual row for a collapsed bash command title/header. A long
 * command is clipped horizontally (with `…`); multi-line scripts/heredocs show
 * only the first line. Anything hidden — extra command lines plus `extraHidden`
 * (e.g. skipped output lines) — folds into an inline `… +N earlier lines (<key>
 * to expand)` trailer (the canonical {@link moreLinesTrailer} shape); a purely
 * horizontal clip shows a bare `(<key> to expand)`.
 *
 * Shared by the agent-issued `bash` tool title and the user `!` bash header so
 * both clamp identically.
 */
export function clampBashCommandRow(opts: {
	command: string;
	width: number;
	colorKey: "toolTitle" | "bashMode";
	/** Hidden lines beyond the multi-line command head (e.g. skipped output). */
	extraHidden?: number;
	/** Pre-styled trailing text (e.g. timeout) — reserved in width and appended. */
	suffix?: string;
	/**
	 * Omit the leading `$ ` sigil. The grouped activity row already shows a `$`
	 * family glyph + the "Ran" verb, so a second `$ ` reads as redundant there.
	 * Default true (keep it) for the user `!` header and the standalone tool title,
	 * which have no glyph and rely on `$ ` to read as a shell command.
	 */
	prefix?: boolean;
	/**
	 * Elide a leading `cd <path> &&` entirely (show just the command) instead of
	 * shortening its path. Used by the activity row, where the `cd …/dir &&`
	 * boilerplate only eats width before the command that matters. Default false.
	 */
	elideCd?: boolean;
	/**
	 * Strip leading `echo <label> &&` diagnostic prefixes before display. Used by
	 * activity rows where agents label probe commands with banner echoes.
	 */
	stripEcho?: boolean;
	/**
	 * Omit inline expand hints. Activity rows are already expandable via ctrl+o on
	 * the whole line — a per-command `(ctrl+o to expand)` suffix reads as noise.
	 */
	suppressExpandHint?: boolean;
}): string {
	const { command, width, colorKey } = opts;
	const extraHidden = opts.extraHidden ?? 0;
	const suffix = opts.suffix ?? "";
	const lines = command.split("\n");
	const firstLine = lines[0] ?? "";
	const head = prepareBashHead(firstLine, { elideCd: opts.elideCd, stripEcho: opts.stripEcho });
	const cmd = theme.fg(colorKey, theme.bold(opts.prefix === false ? head : `$ ${head}`));
	const hiddenLines = lines.length - 1 + extraHidden;
	const suffixW = visibleWidth(suffix);
	const horizontalClip = visibleWidth(cmd) + suffixW > width;
	// Folded hidden lines use the canonical trailer (`… +N earlier lines (<key> to
	// expand)`), unifying with tool-result / error / hint collapse sites. A purely
	// horizontal clip (nothing hidden vertically) keeps the bare affordance since
	// there is no line count to report. Activity rows suppress both — the line
	// itself is the expand target.
	let hint = "";
	if (!opts.suppressExpandHint) {
		if (hiddenLines > 0) {
			hint = ` ${moreLinesTrailer(hiddenLines, expandKeyHint(), "earlier lines")}`;
		} else if (horizontalClip) {
			hint = ` ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}
	// Reserve room for the suffix + hint. At pathologically small widths where
	// they don't even fit, drop both and just clip the command to the full width
	// so the result is always a single row no wider than `width` (the hint/suffix
	// carry no value when nothing legible fits anyway).
	const hintW = visibleWidth(hint);
	if (hintW + suffixW >= width) {
		return truncateToWidth(cmd, Math.max(0, width), "…");
	}
	const avail = width - hintW - suffixW;
	return truncateToWidth(cmd, avail, "…") + suffix + hint;
}
