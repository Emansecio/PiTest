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
