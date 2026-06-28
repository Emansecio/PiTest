import type { AgentToolResult } from "./types.ts";

export interface AppendAnnotatedLinesOptions {
	/** Prefix each line, e.g. `[hint] ` or `[repair] `. */
	prefix: string;
	/** When set, skip append if trailing text already contains this substring. */
	idempotencyKey?: string;
}

/**
 * Append annotated lines to the trailing text block of a tool result.
 * Idempotent when `idempotencyKey` matches existing trailing text.
 * Pushes a fresh text block when none exists (e.g. image-only results).
 */
export function appendAnnotatedLinesToContent(
	content: AgentToolResult<unknown>["content"],
	lines: string[],
	options: AppendAnnotatedLinesOptions,
): AgentToolResult<unknown>["content"] {
	if (lines.length === 0) return content;
	const annotated = lines.map((line) => `${options.prefix}${line}`);
	const suffix = `\n\n${annotated.join("\n")}`;
	const blocks = Array.isArray(content) ? [...content] : [];

	for (let i = blocks.length - 1; i >= 0; i--) {
		const candidate = blocks[i];
		if (candidate && candidate.type === "text" && typeof candidate.text === "string") {
			const key = options.idempotencyKey ?? annotated[0];
			if (candidate.text.includes(key)) {
				return blocks;
			}
			blocks[i] = { ...candidate, text: `${candidate.text}${suffix}` };
			return blocks;
		}
	}

	blocks.push({ type: "text", text: suffix.trimStart() });
	return blocks;
}
