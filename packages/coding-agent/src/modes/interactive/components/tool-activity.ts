import { basename } from "node:path";
import { truncateToWidth } from "@pit/tui";
import { truncateWithEllipsis } from "../../../utils/surrogate.ts";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

export type ToolActivity = "navigation" | "action";

/** Max body lines auto-shown under a failed call before folding into a hint.
 * Errors must stay scannable, not flood the CLI — the full body is one
 * ctrl+o away. Sized to fit a typical stack trace / error message without
 * forcing an expand for the common case. */
export const ERROR_PREVIEW_LINES = 10;

/** Tighter cap for auto-shown errors inside the activity stream (grouped nav /
 * bash / action lines). Keeps a burst of tool calls scannable. */
export const ACTIVITY_ERROR_PREVIEW_LINES = 4;

/** Max diff body lines when a tool row is fully expanded (grouped + legacy). */
export const EDIT_EXPANDED_MAX_LINES = 40;

const EDIT_FAMILY_TOOLS = new Set(["edit", "edit_v2", "ast_edit"]);

export function isEditFamilyTool(toolName: string): boolean {
	return EDIT_FAMILY_TOOLS.has(toolName);
}

export function hasEditDiff(details: { diff?: string } | undefined): boolean {
	return typeof details?.diff === "string" && details.diff.length > 0;
}

/**
 * Cap a diff body to `maxLines`, appending an honest truncation trailer when
 * lines were hidden. Unlike {@link capErrorPreview}, every call site of this
 * helper runs on an already-EXPANDED body (collapsed edit rows render no diff
 * at all), so a "(ctrl+o to expand)" hint here would lie — ctrl+o collapses
 * from this state and the hidden tail is unreachable in the TUI. Say that
 * instead of promising a key.
 */
export function capDiffPreview(lines: string[], width: number, maxLines: number): string[] {
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
	const hidden = lines.length - kept.length;
	kept.push(truncateToWidth(theme.fg("muted", `… +${hidden} more lines (diff truncated — open the file)`), width));
	return kept;
}

/**
 * Canonical "more lines" trailer shown when a body is folded to a preview.
 * One format across every collapse site (tool result / bash / error preview /
 * annotated-hint block): `… +N <noun> (<key> to expand)`. `expandHint` is the
 * already-styled key text for the expand keybinding each site uses (dim key; the
 * ` to expand` words are appended here in muted). `noun` swaps the counter's
 * subject so the same shape covers `more lines` (default), `hint lines`, and
 * `earlier lines` — the three dialects the collapse sites used to diverge on.
 * ANSI is width-free, so callers may still clamp the result with truncateToWidth
 * to honor the TUI invariant.
 */
export function moreLinesTrailer(n: number, expandHint: string, noun = "more lines"): string {
	return `${theme.fg("muted", `… +${n} ${noun}`)} (${expandHint}${theme.fg("muted", " to expand")})`;
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
export function capErrorPreview(lines: string[], width: number, maxLines: number = ERROR_PREVIEW_LINES): string[] {
	if (lines.length <= maxLines) return lines;
	const kept = lines.slice(0, maxLines);
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
	recall_history: "recall",
	recall_tool_output: "recall",
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
	plan: "plan",
	task: "agent",
};

export function nounFor(toolName: string): string {
	return TOOL_NOUNS[toolName] ?? "step";
}

/** Dense separator for activity counters — no lateral padding, so a burst reads
 * `5 searches·8 commands·2 edits` instead of the airier `… · … · …`. Kept as one
 * constant so every counter (nav group, work group, basename list) stays uniform. */
export const COUNTER_SEP = "·";

/** Leading gutter glyph for a settled action/work-group row — a steady accent
 * dot, independent of outcome (success/error/aborted all show the same dot; the
 * outcome rides on the TRAILING icon instead, see {@link ICON_SUCCESS}-alikes in
 * activity-line.ts/work-group.ts). Shared so both files render the same glyph. */
export const GUTTER_DOT = "●";

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
	plan: { done: "Updated plan", pending: "Updating plan" },
};

export function verbFor(toolName: string, pending: boolean): string {
	const v = ACTION_VERBS[toolName] ?? { done: "Ran", pending: "Running" };
	return pending ? v.pending : v.done;
}

/**
 * Parse MCP-style tool names (`server__tool` or `server.tool`) into server +
 * short tool for activity headers. Returns null for built-in / plain names.
 */
export function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
	const name = toolName.trim();
	if (!name) return null;
	const dunder = name.indexOf("__");
	if (dunder > 0 && dunder < name.length - 2) {
		return { server: name.slice(0, dunder), tool: name.slice(dunder + 2) };
	}
	// Single-dot server.tool (not file paths / versions): require both sides non-empty
	// and no extra dots after the first separator.
	const dot = name.indexOf(".");
	if (dot > 0 && dot < name.length - 1 && !name.includes("/") && !name.includes("\\")) {
		const server = name.slice(0, dot);
		const tool = name.slice(dot + 1);
		if (server && tool && !tool.includes(".")) {
			return { server, tool };
		}
	}
	return null;
}

/** Colored `server shortName` target for MCP activity headers when no path target exists. */
export function mcpActivityTarget(toolName: string): string {
	const parsed = parseMcpToolName(toolName);
	if (!parsed) return "";
	return `${theme.fg("muted", parsed.server)} ${theme.fg("toolTitle", parsed.tool)}`;
}

/**
 * Coalescing key for an action line: consecutive actions that share a key fold
 * into one line with a `×N` count instead of stacking N identical rows (e.g.
 * four `todo` updates → `Updated todos ×4`). Keyed by tool name + the call's
 * target identity (path / command / query) so repeated edits to the SAME file
 * also fold, while two different commands stay distinct. Returns `null` for
 * tools that must never coalesce (each `task` agent is its own line).
 */
export function actionCoalesceKey(toolName: string, args: Record<string, unknown> | undefined): string | null {
	if (toolName === "task") return null;
	const a = args ?? {};
	const target =
		typeof a.path === "string"
			? a.path
			: typeof a.file_path === "string"
				? a.file_path
				: typeof a.command === "string"
					? a.command
					: typeof a.query === "string"
						? a.query
						: "";
	return `${toolName}|${target}`;
}

const WORKING_TARGET_MAX = 48;

/** Compact target for activity headers and the working loader (basename for paths). */
export function activityTargetLabel(toolName: string, args: Record<string, unknown>): string {
	if (toolName === "bash") {
		const cmd = String(args.command ?? "").trim();
		if (!cmd) return "";
		return truncateWithEllipsis(cmd.replace(/\s+/g, " "), WORKING_TARGET_MAX);
	}
	if (toolName === "web_search") {
		const q = String(args.query ?? "").trim();
		return q ? truncateWithEllipsis(q, WORKING_TARGET_MAX) : "";
	}
	let rawPath = "";
	if (typeof args.path === "string") {
		rawPath = args.path;
	} else if (typeof args.file_path === "string") {
		rawPath = args.file_path;
	}
	if (rawPath) {
		const name = basename(rawPath.replace(/[\\/]+$/, ""));
		return name ? truncateWithEllipsis(name, WORKING_TARGET_MAX) : "";
	}
	return "";
}

/** Label for the working loader while a tool executes. Uses verbFor + short target. */
export function workingPhaseLabel(
	toolName: string,
	args: Record<string, unknown> | undefined,
	pending: boolean,
): string {
	const verb = verbFor(toolName, pending);
	const target = activityTargetLabel(toolName, args ?? {});
	if (target) return `${verb} ${target}…`;
	if (verbFor("", pending) === verb && toolName !== "bash") {
		return `${toolName}…`;
	}
	return `${verb}…`;
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
