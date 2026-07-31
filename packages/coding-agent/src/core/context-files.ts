/**
 * Project context file normalization (E6, E16).
 */

import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { headTailExcerpt } from "./compaction/utils.ts";

/** Inline cap for project_context in the cacheable prefix; above → retrieval excerpt. */
export const PROJECT_CONTEXT_INLINE_MAX_CHARS = 8000;

/**
 * Aggregate char cap for the entire project_context block (M25a).
 * Files that would push the running total past this threshold are
 * replaced by a 1-line read-pointer so the prompt stays bounded even
 * when many large context files are installed.
 */
export const PROJECT_CONTEXT_AGGREGATE_MAX_CHARS = 16_000;

function normalizePathKey(filePath: string): string {
	return resolve(filePath).replace(/\\/g, "/").toLowerCase();
}

function dirKey(filePath: string): string {
	return dirname(resolve(filePath)).replace(/\\/g, "/").toLowerCase();
}

/** Hard ceiling: nothing this large is a pointer stub, skip the scan entirely. */
const POINTER_MAX_CHARS = 6000;

/**
 * How much non-pointer text a CLAUDE.md may still contain and count as
 * "essentially only a pointer". A `@AGENTS.md` import collapses to 0; a one
 * paragraph "the rules live in AGENTS.md" stub lands well under this.
 */
const POINTER_RESIDUAL_MAX_CHARS = 200;

/**
 * Slightly larger residual allowance when the file ALSO states outright that
 * AGENTS.md is canonical. The phrases are reinforcement for a stub that is a bit
 * chattier than usual — never a licence to drop a file with a real body.
 */
const POINTER_RESIDUAL_MAX_CHARS_WITH_SIGNAL = 400;

const POINTER_SIGNAL_PHRASES = ["single source of truth", "points here", "same rules", "lands on the"] as const;

/**
 * Length of what survives once every pointer-shaped construct is stripped:
 * `@path` context imports, markdown links / quoted / bare mentions of AGENTS.md,
 * and all whitespace. A pure redirect collapses to ~nothing; a CLAUDE.md that
 * carries its own rules and merely *mentions* AGENTS.md keeps its whole body.
 */
function pointerResidualLength(content: string): number {
	return content
		.replace(/(^|[^\w@])@\S+/g, "$1")
		.replace(/\[[^\]\n]*\]\([^)\n]*agents\.md[^)\n]*\)/gi, "")
		.replace(/[`'"(<]?[\w./-]*agents\.md[`'">)]?/gi, "")
		.replace(/\s+/g, "").length;
}

/**
 * True when the file is a CLAUDE.md whose ENTIRE content is a redirect to
 * AGENTS.md (E16) — i.e. safe for {@link dedupePointerContextFiles} to drop when
 * the canonical AGENTS.md sits in the same directory.
 *
 * The criterion is residual content, not raw size: a 3 KB CLAUDE.md with real
 * project rules that happens to say "see AGENTS.md for the glossary" is NOT a
 * pointer and must survive — dropping it silently discards user instructions.
 */
export function isPointerEntryPoint(filePath: string, content: string): boolean {
	const base = basename(filePath);
	const baseLower = base.toLowerCase();
	if (baseLower !== "claude.md") return false;
	if (content.length > POINTER_MAX_CHARS) return false;
	const lower = content.toLowerCase();
	if (!lower.includes("agents.md")) return false;
	const residual = pointerResidualLength(content);
	if (residual <= POINTER_RESIDUAL_MAX_CHARS) return true;
	if (residual > POINTER_RESIDUAL_MAX_CHARS_WITH_SIGNAL) return false;
	return POINTER_SIGNAL_PHRASES.some((phrase) => lower.includes(phrase));
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
 * Build a 1-line read-pointer for a file that is excluded from the inlined
 * project_context block because the aggregate cap (M25a) has been reached.
 * Follows the same read-hint style as {@link formatRetrievalExcerpt}.
 */
export function formatAggregatePointer(file: { path: string; content: string }, cwd?: string): string {
	const readPath =
		cwd !== undefined
			? relative(resolve(cwd), resolve(file.path)).replace(/\\/g, "/") || basename(file.path)
			: file.path.replace(/\\/g, "/");
	return `[Project context aggregate cap reached. Use read({ path: "${readPath}" }) to load this file (${file.content.length} chars).]`;
}

function isUnderDir(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Specificity rank used to spend the aggregate budget (lower = more specific =
 * consumes the budget first).
 *
 * The emission order is global → outer ancestors → cwd, so a plain in-order
 * budget walk makes a big global/ancestral AGENTS.md starve the project's own
 * rules — exactly the highest-value file. Rank restores intent:
 *  0  — the cwd itself, anything below it (legacy rule files live in
 *       `.cursor/`, `.github/`, …) and synthetic entries derived from the
 *       project (`<project-config>`);
 *  n  — an ancestor n directories above cwd (closer ancestor wins);
 *  MAX — anywhere else (global agent dir, home config).
 * Without a cwd every file ranks 0, so the walk degrades to the original order.
 */
function contextSpecificityRank(filePath: string, cwd?: string): number {
	if (cwd === undefined) return 0;
	// Synthetic, non-filesystem entries (e.g. "<project-config>") are distilled
	// from the project itself — resolving them would point at process.cwd().
	if (filePath.startsWith("<")) return 0;
	const dir = dirname(resolve(filePath));
	const root = resolve(cwd);
	if (dir === root || isUnderDir(dir, root)) return 0;
	if (isUnderDir(root, dir)) {
		return relative(dir, root).split(/[\\/]/).filter(Boolean).length;
	}
	return Number.MAX_SAFE_INTEGER;
}

/**
 * Enforce a total char budget across all project context files (M25a).
 *
 * The budget is spent in specificity order ({@link contextSpecificityRank}) so
 * the project's own rules are inlined before an ancestral or global file can
 * consume the budget; once the cumulative char count would exceed
 * {@link PROJECT_CONTEXT_AGGREGATE_MAX_CHARS}, the offending file — and every
 * less specific one — is reduced to a 1-line read-pointer so the model can still
 * discover and load them on demand. Emission order is the caller's order
 * (global → cwd), untouched.
 */
export function applyAggregateContextCap(
	files: Array<{ path: string; content: string }>,
	cwd?: string,
): Array<{ path: string; content: string }> {
	const byPriority = files
		.map((file, index) => ({ file, index, rank: contextSpecificityRank(file.path, cwd) }))
		.sort((a, b) => a.rank - b.rank || a.index - b.index);

	const pointerIndexes = new Set<number>();
	let total = 0;
	let capReached = false;
	for (const { file, index } of byPriority) {
		if (capReached) {
			pointerIndexes.add(index);
			continue;
		}
		const next = total + file.content.length;
		if (next > PROJECT_CONTEXT_AGGREGATE_MAX_CHARS) {
			capReached = true;
			pointerIndexes.add(index);
			continue;
		}
		total = next;
	}

	return files.map((file, index) =>
		pointerIndexes.has(index) ? { path: file.path, content: formatAggregatePointer(file, cwd) } : file,
	);
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
	const excerpted = applyContextRetrievalMode(deduped, cwd);
	return applyAggregateContextCap(excerpted, cwd);
}
