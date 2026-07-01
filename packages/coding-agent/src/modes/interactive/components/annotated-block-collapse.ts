/** Prefixes appended to tool error results for LLM recovery (Tier-4 hints, repair notes). */
const DEFAULT_ANNOTATED_PREFIXES = ["[hint] ", "[repair] "] as const;

export interface CollapseAnnotatedBlocksOptions {
	expanded: boolean;
	/** Style the collapse trailer (typically theme.fg("muted", …)). */
	muted: (text: string) => string;
	/** Shown in the trailer, e.g. "ctrl+o to expand". */
	expandHint: string;
	prefixes?: readonly string[];
}

/**
 * Collapse consecutive `[hint]` / `[repair]` lines in rendered tool output when
 * the row is not expanded. The underlying `result.content` is unchanged — this
 * is display-only so the CLI stays scannable while the LLM still sees full hints.
 */
export function collapseAnnotatedBlocks(text: string, opts: CollapseAnnotatedBlocksOptions): string {
	if (opts.expanded) return text;
	const prefixes = opts.prefixes ?? DEFAULT_ANNOTATED_PREFIXES;
	const lines = text.split("\n");
	const start = lines.findIndex((line) => prefixes.some((prefix) => line.startsWith(prefix)));
	if (start < 0) return text;

	let end = start;
	while (end < lines.length && prefixes.some((prefix) => lines[end].startsWith(prefix))) {
		end++;
	}

	const block = lines.slice(start, end);
	const hidden = block.length - 1;
	const kept = lines.slice(0, start + 1);
	if (hidden > 0) {
		kept.push(opts.muted(`… (${hidden} hint lines, ${opts.expandHint})`));
	}
	return [...kept, ...lines.slice(end)].join("\n");
}
