import type { ToolDefinition } from "../../../core/extensions/types.ts";
import { summarizeArgsOneLine } from "./arg-summary.ts";

export type ToolActivity = "navigation" | "action";

/** Resolve a tool's activity family. The `activity` field may be a static value
 * or a function of the call args (e.g. bash classifies by command); pass `args`
 * to resolve the dynamic case. Defaults to "action" (safe: own line). */
export function toolActivityFamily(def: ToolDefinition<any, any> | undefined, args?: unknown): ToolActivity {
	const activity = def?.activity;
	if (typeof activity === "function") {
		try {
			return activity(args);
		} catch {
			return "action";
		}
	}
	return activity ?? "action";
}

/** Count added/removed lines in the custom edit diff. The prefix (+/-/space) is
 * always char[0]; the line number follows. Context lines start with a space, so
 * content that itself begins with +/- never miscounts. */
export function computeDiffStat(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		const c = line.charCodeAt(0);
		if (c === 43)
			added++; // '+'
		else if (c === 45) removed++; // '-'
	}
	return { added, removed };
}

const NAV_NOUNS: Record<string, string> = {
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
	// Action tools — folded into the same aggregated group ("all" grouping).
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

/** Singular noun for a tool's aggregated counter (navigation or action). */
export function navNounFor(toolName: string): string {
	return NAV_NOUNS[toolName] ?? "step";
}

export function pluralizeNoun(noun: string, n: number): string {
	if (n === 1) return noun;
	if (noun.endsWith("h") || noun.endsWith("s")) return `${noun}es`;
	return `${noun}s`;
}

const ACTION_VERBS: Record<string, string> = {
	edit: "Edited",
	edit_v2: "Edited",
	ast_edit: "Edited",
	write: "Wrote",
	bash: "Ran",
	web_search: "Searched",
};

const EDIT_TOOLS = new Set(["edit", "edit_v2", "ast_edit"]);

function capitalize(s: string): string {
	return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

function truncate(s: string, max: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function pickPath(args: any): string {
	return String(args?.path ?? args?.file_path ?? args?.filename ?? "");
}

export interface ActionSummary {
	verb: string;
	identifier: string;
	diffstat?: { added: number; removed: number };
}

/** Verb + identifier (+ diffstat for edits) for an action line header. */
export function formatActionSummary(toolName: string, args: any, details: any): ActionSummary {
	const verb = ACTION_VERBS[toolName] ?? capitalize(toolName);
	if (EDIT_TOOLS.has(toolName)) {
		const diff = details?.diff;
		return {
			verb,
			identifier: pickPath(args),
			diffstat: typeof diff === "string" ? computeDiffStat(diff) : undefined,
		};
	}
	if (toolName === "write") {
		return { verb, identifier: pickPath(args), diffstat: undefined };
	}
	if (toolName === "bash") {
		return { verb, identifier: `$ ${truncate(String(args?.command ?? args?.cmd ?? ""), 80)}`, diffstat: undefined };
	}
	if (toolName === "web_search") {
		return { verb, identifier: truncate(String(args?.query ?? args?.q ?? ""), 80), diffstat: undefined };
	}
	return { verb, identifier: summarizeArgsOneLine(args), diffstat: undefined };
}
