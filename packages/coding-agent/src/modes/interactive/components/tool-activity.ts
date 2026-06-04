export type ToolActivity = "navigation" | "action";

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
