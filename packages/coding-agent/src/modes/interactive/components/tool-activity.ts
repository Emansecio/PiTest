import { truncateToWidth } from "@pit/tui";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";

export type ToolActivity = "navigation" | "action";

/** Max body lines auto-shown under a failed call before folding into a hint.
 * Errors must stay scannable, not flood the CLI — the full body is one
 * ctrl+o away. Sized to fit a typical stack trace / error message without
 * forcing an expand for the common case. */
export const ERROR_PREVIEW_LINES = 10;

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
	kept.push(
		truncateToWidth(
			`${theme.fg("muted", `… +${hidden} more lines`)} (${keyHint("app.tools.expand", "to expand")})`,
			width,
		),
	);
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

export function pluralizeNoun(noun: string, n: number): string {
	if (n === 1) return noun;
	if (noun.endsWith("h") || noun.endsWith("s")) return `${noun}es`;
	return `${noun}s`;
}

/** Past/present verb for an action line. `pending` selects the present
 * participle shown while the call runs (spinner state). Unknown action tools
 * fall back to the neutral Ran/Running pair. */
const ACTION_VERBS: Record<string, { done: string; pending: string }> = {
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
