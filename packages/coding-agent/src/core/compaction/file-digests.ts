import { listDeclarations } from "../tools/symbol.js";

/**
 * path -> "sym1, sym2, …" derived from each readable source file's current
 * content. LOSSY guide (outline at compaction time) — the model must re-read
 * for current content. Pure: content is supplied by the caller.
 */
export async function buildFileDigests(
	paths: string[],
	readContent: (path: string) => string | null | Promise<string | null>,
): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	for (const path of paths) {
		const content = await readContent(path);
		if (!content) continue;
		const names = listDeclarations(content, path)
			.map((d) => d.name)
			.slice(0, 12);
		if (names.length > 0) out[path] = names.join(", ");
	}
	return out;
}

/** Render a `<file-digests>` block for the compaction summary. */
export function formatFileDigests(digests: Record<string, string>): string {
	const entries = Object.entries(digests);
	if (entries.length === 0) return "";
	const body = entries.map(([path, syms]) => `  ${path}: ${syms}`).join("\n");
	return `<file-digests>\n  (outline at compaction time — re-read for current content)\n${body}\n</file-digests>`;
}
