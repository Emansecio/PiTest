import { listDeclarations } from "../tools/symbol.js";

/**
 * Skip the symbol parse for bodies above this size: a touched lockfile, bundle,
 * or data dump would otherwise be fully parsed during compaction for an outline
 * no one wants. Bounds the worst case of default-on modified-file digests.
 */
const MAX_DIGEST_BYTES = 256 * 1024;

/**
 * path -> "sym1, sym2, …" derived from each readable source file's current
 * content. LOSSY guide (outline at compaction time) — the model must re-read
 * for current content. Pure: content is supplied by the caller.
 *
 * Reads run concurrently (independent I/O); `signal`, when provided, both
 * short-circuits the parse and is honored by the caller's `readContent` so an
 * aborted compaction stops issuing work. Insertion order follows `paths`.
 */
export async function buildFileDigests(
	paths: string[],
	readContent: (path: string) => string | null | Promise<string | null>,
	signal?: AbortSignal,
): Promise<Record<string, string>> {
	const entries = await Promise.all(
		paths.map(async (path): Promise<readonly [string, string] | undefined> => {
			if (signal?.aborted) return undefined;
			const content = await readContent(path);
			if (!content || content.length > MAX_DIGEST_BYTES) return undefined;
			const names = listDeclarations(content, path)
				.map((d) => d.name)
				.slice(0, 12);
			return names.length > 0 ? ([path, names.join(", ")] as const) : undefined;
		}),
	);
	const out: Record<string, string> = {};
	for (const entry of entries) {
		if (entry) out[entry[0]] = entry[1];
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
