/**
 * Project context file normalization (E6, E16).
 */

import { basename, dirname, relative, resolve } from "node:path";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { headTailExcerpt } from "./compaction/utils.ts";

/** Inline cap for project_context in the cacheable prefix; above → retrieval excerpt. */
export const PROJECT_CONTEXT_INLINE_MAX_CHARS = 8000;

function normalizePathKey(filePath: string): string {
	return resolve(filePath).replace(/\\/g, "/").toLowerCase();
}

function dirKey(filePath: string): string {
	return dirname(resolve(filePath)).replace(/\\/g, "/").toLowerCase();
}

/** True when the file is a short entry-point pointer to AGENTS.md (E16). */
export function isPointerEntryPoint(filePath: string, content: string): boolean {
	const base = basename(filePath);
	const baseLower = base.toLowerCase();
	if (baseLower !== "claude.md") return false;
	if (content.length > 6000) return false;
	const lower = content.toLowerCase();
	if (!lower.includes("agents.md")) return false;
	if (content.length <= 3500) return true;
	return (
		lower.includes("single source of truth") ||
		lower.includes("points here") ||
		lower.includes("same rules") ||
		lower.includes("lands on the")
	);
}

function isAgentsBasename(filePath: string): boolean {
	const base = basename(filePath).toLowerCase();
	return base === "agents.md";
}

function hasAgentsFileInDir(files: Array<{ path: string; content: string }>, dir: string): boolean {
	const key = dir.replace(/\\/g, "/").toLowerCase();
	for (const file of files) {
		if (dirKey(file.path) !== key) continue;
		if (isAgentsBasename(file.path)) return true;
	}
	return false;
}

/**
 * Drop redundant pointer files when the canonical AGENTS.md exists in the same
 * directory (E16).
 */
export function dedupePointerContextFiles(
	files: Array<{ path: string; content: string }>,
): Array<{ path: string; content: string }> {
	const out: Array<{ path: string; content: string }> = [];
	for (const file of files) {
		if (isPointerEntryPoint(file.path, file.content) && hasAgentsFileInDir(files, dirKey(file.path))) {
			continue;
		}
		out.push(file);
	}
	return out;
}

function formatRetrievalExcerpt(content: string, filePath: string, cwd?: string): string {
	const headBudget = Math.floor(PROJECT_CONTEXT_INLINE_MAX_CHARS * 0.6);
	const tailBudget = PROJECT_CONTEXT_INLINE_MAX_CHARS - headBudget;
	const excerpt = headTailExcerpt(content, {
		headBudget,
		tailBudget,
		snapWindow: 200,
		marker: (elided) => `[... ${elided} characters elided ...]`,
	});
	const readPath =
		cwd !== undefined
			? relative(resolve(cwd), resolve(filePath)).replace(/\\/g, "/") || basename(filePath)
			: filePath.replace(/\\/g, "/");
	return `${excerpt}\n\n[Project rules truncated (${content.length} chars). Use read({ path: "${readPath}" }) for the full file before large or repo-wide changes.]`;
}

/**
 * Shrink oversized context files to a head+tail excerpt with a read hint (E6).
 */
export function applyContextRetrievalMode(
	files: Array<{ path: string; content: string }>,
	cwd?: string,
): Array<{ path: string; content: string }> {
	return files.map((file) => {
		if (file.content.length <= PROJECT_CONTEXT_INLINE_MAX_CHARS) return file;
		return {
			path: file.path,
			content: formatRetrievalExcerpt(file.content, file.path, cwd),
		};
	});
}

/** Dedupe pointer files, then apply retrieval caps. */
export function normalizeProjectContextFiles(
	files: Array<{ path: string; content: string }>,
	cwd?: string,
): Array<{ path: string; content: string }> {
	const seen = new Set<string>();
	const unique: Array<{ path: string; content: string }> = [];
	for (const file of files) {
		const key = normalizePathKey(file.path);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(file);
	}
	const deduped = dedupePointerContextFiles(unique);
	if (isTruthyEnvFlag(process.env.PIT_NO_CONTEXT_RETRIEVAL)) return deduped;
	return applyContextRetrievalMode(deduped, cwd);
}
