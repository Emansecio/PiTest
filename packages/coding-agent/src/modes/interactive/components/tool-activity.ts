import { truncateToWidth } from "@pit/tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export type ToolActivity = "navigation" | "action";

/** Max body lines auto-shown under a failed call before folding into a hint.
 * Errors must stay scannable, not flood the CLI — the full body is one
 * ctrl+o away. Sized to fit a typical stack trace / error message without
 * forcing an expand for the common case. */
export const ERROR_PREVIEW_LINES = 10;

/**
 * Canonical "more lines" trailer shown when a body is folded to a preview.
 * One format across every collapse site (tool result / bash / error preview):
 * `… +N more lines (<key> to expand)`. `expandHint` is the already-styled key
 * text for the expand keybinding each site uses (dim key + muted words), so the
 * shortcut shown stays whatever that site binds. ANSI is width-free, so callers
 * may still clamp the result with truncateToWidth to honor the TUI invariant.
 */
export function moreLinesTrailer(n: number, expandHint: string): string {
	return `${theme.fg("muted", `… +${n} more lines`)} (${expandHint}${theme.fg("muted", " to expand")})`;
}

/** Styled key text for the standard expand keybinding, used as the `expandHint`
 * argument to {@link moreLinesTrailer}. Dim to match the other inline hints. */
export function expandKeyHint(): string {
	return theme.fg("dim", keyText("app.tools.expand"));
}

/**
 * Cap an auto-shown error body to {@link ERROR_PREVIEW_LINES}, appending a
 * muted `… +N more lines (… to expand)` trailer when lines were hidden.
 * `width` is the cell budget of each body line (already inset by the caller);
 * the trailer is clamped to it so the TUI width invariant holds.
 */
export function capErrorPreview(lines: string[], width: number): string[] {
	if (lines.length <= ERROR_PREVIEW_LINES) return lines;
	const kept = lines.slice(0, ERROR_PREVIEW_LINES);
	const hidden = lines.length - kept.length;
	kept.push(truncateToWidth(moreLinesTrailer(hidden, expandKeyHint()), width));
	return kept;
}

/** Singular noun for a tool's aggregated activity-group counter. Covers both
 * navigation and action tools, since the grouped mode folds every call into one
 * group (e.g. `4 files · 2 edits · 1 command`). */
const TOOL_NOUNS: Record<string, string> = {
	read: "file",
	grep: "search",
	ast_grep: "search",
	search_tool_bm25: "search",
	find: "match",
	ls: "list",
	symbol: "symbol",
	recall: "recall",
	reflect: "reflection",
	recipe: "recipe",
	calc: "calc",
	inspect_image: "image",
	chrome_devtools_list_pages: "page",
	chrome_devtools_screenshot: "screenshot",
	chrome_devtools_read_console: "console read",
	chrome_devtools_read_network: "network read",
	chrome_devtools_click: "click",
	chrome_devtools_fill: "fill",
	chrome_devtools_press_key: "key press",
	chrome_devtools_get_text: "page text",
	chrome_devtools_wait_for: "wait",
	chrome_devtools_hover: "hover",
	chrome_devtools_select_option: "option",
	chrome_devtools_upload_file: "upload",
	chrome_devtools_snapshot: "snapshot",
	chrome_devtools_get_network_body: "response body",
	chrome_devtools_element_to_source: "source map",
	edit: "edit",
	edit_v2: "edit",
	ast_edit: "edit",
	write: "file written",
	bash: "command",
	web_search: "search",
	eval: "eval",
	render_mermaid: "diagram",
	todo: "todo",
	ask: "question",
	resolve: "answer",
	preview: "preview",
};

export function nounFor(toolName: string): string {
	return TOOL_NOUNS[toolName] ?? "step";
}

const CONSONANTS_BEFORE_Y = /[bcdfghjklmnpqrstvwxz]y$/i;

export function pluralizeNoun(noun: string, n: number): string {
	if (n === 1) return noun;
	// consonant + y → ies (body → bodies); vowel + y keeps +s (key → keys).
	if (CONSONANTS_BEFORE_Y.test(noun)) return `${noun.slice(0, -1)}ies`;
	// sibilant endings (s, x, z, ch, sh) → es (search → searches, match → matches).
	if (noun.endsWith("s") || noun.endsWith("x") || noun.endsWith("z") || noun.endsWith("ch") || noun.endsWith("sh")) {
		return `${noun}es`;
	}
	return `${noun}s`;
}

/** Past/present verb for an action line. `pending` selects the present
 * participle shown while the call runs (spinner state). Unknown action tools
 * fall back to the neutral Ran/Running pair. */
const ACTION_VERBS: Record<string, { done: string; pending: string }> = {
	read: { done: "Read", pending: "Reading" },
	edit: { done: "Edited", pending: "Editing" },
	edit_v2: { done: "Edited", pending: "Editing" },
	ast_edit: { done: "Edited", pending: "Editing" },
	write: { done: "Wrote", pending: "Writing" },
	bash: { done: "Ran", pending: "Running" },
	web_search: { done: "Searched", pending: "Searching" },
	eval: { done: "Evaluated", pending: "Evaluating" },
	render_mermaid: { done: "Rendered", pending: "Rendering" },
	preview: { done: "Previewed", pending: "Previewing" },
	todo: { done: "Updated todos", pending: "Updating todos" },
};

export function verbFor(toolName: string, pending: boolean): string {
	const v = ACTION_VERBS[toolName] ?? { done: "Ran", pending: "Running" };
	return pending ? v.pending : v.done;
}

/** Per-tool-type glyph rendered between the state icon and the label so the
 * action family (edit / run / search / read / …) is legible at a glance. Every
 * glyph here is verified width-1 (one terminal cell) so it never shifts the
 * label column — emoji / variation-selectors that measure 2 are banned. */
const TOOL_GLYPH: Record<string, string> = {
	edit: "✎",
	edit_v2: "✎",
	ast_edit: "✎",
	write: "✎",
	bash: "$",
	grep: "⌕",
	find: "⌕",
	ast_grep: "⌕",
	search_tool_bm25: "⌕",
	web_search: "⌕",
	read: "▸",
	task: "◆",
	subagent: "◆",
	preview: "◑",
};

/** Family tint for a type glyph, mapped onto existing theme tokens (no new
 * tokens): edits read as `success`, shell as `warning`, searches/reads as
 * `accent`, agents as `toolTitle`. Unmapped → muted neutral. */
const TOOL_GLYPH_COLOR: Record<string, ThemeColor> = {
	edit: "success",
	edit_v2: "success",
	ast_edit: "success",
	write: "success",
	bash: "warning",
	grep: "accent",
	find: "accent",
	ast_grep: "accent",
	search_tool_bm25: "accent",
	web_search: "accent",
	read: "accent",
	task: "toolTitle",
	subagent: "toolTitle",
	preview: "toolTitle",
};

/** Neutral fallback glyph for tools without a mapped type glyph (MCP/unknown). */
const FALLBACK_GLYPH = "·";

/**
 * Colorized, width-1 type glyph for a tool, tinted by family. Falls back to a
 * muted neutral dot for unmapped tools so every activity line keeps a stable
 * `<state> <glyph> <label>` shape. The returned string is exactly one visible
 * cell wide (ANSI is width-free), preserving the TUI width invariant.
 */
export function glyphFor(toolName: string): string {
	const glyph = TOOL_GLYPH[toolName];
	if (glyph === undefined) return theme.fg("muted", FALLBACK_GLYPH);
	return theme.fg(TOOL_GLYPH_COLOR[toolName] ?? "muted", glyph);
}

export function diffStat(diff: string | undefined): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	if (!diff) return { added, removed };
	for (const line of diff.split("\n")) {
		if (line[0] === "+") added++;
		else if (line[0] === "-") removed++;
	}
	return { added, removed };
}
