import { redactForDisk } from "../secret-redactor.ts";
import { listDeclarations } from "../tools/symbol.js";

/**
 * Skip the symbol parse for bodies above this size: a touched lockfile, bundle,
 * or data dump would otherwise be fully parsed during compaction for an outline
 * no one wants. Bounds the worst case of default-on modified-file digests.
 */
const MAX_DIGEST_BYTES = 256 * 1024;

/** Symbols kept per file before a `(+N more)` truncation marker (mirrors living-index). */
const MAX_SYMBOLS_PER_FILE = 12;

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
	preSeed?: Record<string, string>,
): Promise<Record<string, string>> {
	const entries = await Promise.all(
		paths.map(async (path): Promise<readonly [string, string] | undefined> => {
			if (signal?.aborted) return undefined;
			// Cache hit: a precomputed outline (the living repo map) already holds this
			// file's symbols — skip the disk read + parse. Still run it through
			// redactForDisk so a seeded symbol can't bypass the credential scrub the
			// from-disk path applies below (the digest is persisted to disk + remote).
			const seeded = preSeed?.[path];
			if (seeded !== undefined && seeded.length > 0) {
				return [path, redactForDisk(seeded)] as const;
			}
			const content = await readContent(path);
			if (!content || content.length > MAX_DIGEST_BYTES) return undefined;
			const decls = listDeclarations(content, path);
			const names = decls.slice(0, MAX_SYMBOLS_PER_FILE).map((d) => `${d.kind} ${d.name}:${d.line}`);
			if (names.length === 0) return undefined;
			// Mark truncation so the model knows the outline is partial, not the whole file.
			if (decls.length > MAX_SYMBOLS_PER_FILE) names.push(`(+${decls.length - MAX_SYMBOLS_PER_FILE} more)`);
			// The digest is persisted into the compaction summary (disk + remote),
			// so scrub any credential-shaped symbol/value before it leaves memory.
			// Output is plain text, so plain-string redaction stays well-formed.
			return [path, redactForDisk(names.join(", "))] as const;
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
