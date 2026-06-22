import { truncateToWidth, visibleWidth } from "@pit/tui";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

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
 * Build a single visual row for a collapsed bash command title/header. A long
 * command is clipped horizontally (with `…`); multi-line scripts/heredocs show
 * only the first line. Anything hidden — extra command lines plus `extraHidden`
 * (e.g. skipped output lines) — folds into an inline `(N earlier lines, …to
 * expand)` hint; a purely horizontal clip shows a bare `(…to expand)`.
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
}): string {
	const { command, width, colorKey } = opts;
	const extraHidden = opts.extraHidden ?? 0;
	const suffix = opts.suffix ?? "";
	const lines = command.split("\n");
	const firstLine = lines[0] ?? "";
	const head = opts.elideCd ? stripLeadingCd(firstLine) : collapseCdPrefix(firstLine);
	const cmd = theme.fg(colorKey, theme.bold(opts.prefix === false ? head : `$ ${head}`));
	const hiddenLines = lines.length - 1 + extraHidden;
	const suffixW = visibleWidth(suffix);
	const horizontalClip = visibleWidth(cmd) + suffixW > width;
	const hint =
		hiddenLines > 0
			? ` ${theme.fg("muted", `(${hiddenLines} earlier lines,`)} ${keyHint("app.tools.expand", "to expand")})`
			: horizontalClip
				? ` ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
				: "";
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
