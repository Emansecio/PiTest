/**
 * Deterministic grounding for compaction summaries.
 *
 * Generalizes the grounding firewall (which already runs pre-tool-call in
 * `core/built-ins/`) into the compaction band: a generated summary that cites
 * a file path the model never touched — or that does not exist on disk — is the
 * most dangerous form of compaction hallucination, because it survives into
 * the post-compaction context as if it were fact. This layer validates every
 * path-like token in the summary PROSE against the operation lists the
 * compaction already collected, and against the filesystem. Ungrounded paths
 * are ANNOTATED `(unverified)` on their first occurrence — never deleted, since
 * a mutilated summary is worse than a marked one — and reported via a
 * diagnostic.
 *
 * Pure and zero-LLM: runs for every provider, costs nothing but a regex scan
 * and (lazily, only for paths not in the lists) an existsSync per unique path.
 * Applied BEFORE the deterministic structural frame (`formatFileOperations` /
 * `formatFileDigests`) is appended, since that frame is correct by
 * construction.
 */

import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import type { OperationLists } from "./utils.ts";

export interface GroundedSummary {
	/** The summary prose with ungrounded paths annotated `(unverified)` on first occurrence. */
	summary: string;
	/** Path tokens that were neither in the operation lists nor on disk, in first-occurrence order. */
	ungroundedPaths: string[];
}

/**
 * Conservative path-token matcher: requires a directory separator AND a file
 * extension, so bare filenames (`foo.ts`), single words, and most prose are not
 * flagged. Accepts Windows (`C:\…\foo.ts`), relative (`./…`, `../…`, `src/…`),
 * and absolute (`/…/foo.ts`) forms. The negative lookbehind avoids matching
 * inside a URL scheme (`https://…`) and mid-word.
 */
const PATH_TOKEN_RE = /(?<![:\w])(?:[A-Za-z]:[\\/]|\.{0,2}\/)?[\w.-]+(?:[\\/][\w.-]+)+\.\w{1,8}/g;

/** Marker appended to the first occurrence of an ungrounded path. */
const UNGROUNDED_MARKER = " (unverified)";

function normalizeSep(p: string): string {
	return p.replace(/\\/g, "/");
}

/**
 * True when `candidate` (already `/`-normalized) is grounded by the operation
 * lists or the filesystem. Lenient by design — a false positive (marking a
 * legitimate path) is worse than missing a fabricated one, so the check
 * accepts a list/candidate match in either direction (suffix match handles
 * relative-vs-absolute forms) and falls back to an existsSync against `cwd`.
 */
function isGrounded(candidate: string, grounded: Set<string>, cwd: string | undefined): boolean {
	if (grounded.has(candidate)) return true;
	for (const g of grounded) {
		if (g === candidate) return true;
		// candidate is a suffix of a grounded path (relative cited vs absolute list, or vice versa)
		if (g.endsWith(`/${candidate}`)) return true;
		if (candidate.endsWith(`/${g}`)) return true;
	}
	// Filesystem fallback: a path the model read via a non-file tool, or one that
	// dropped out of the capped operation lists, still counts as grounded if it
	// actually exists. Resolve against cwd when the candidate is relative.
	try {
		if (isAbsolute(candidate) && existsSync(candidate)) return true;
	} catch {
		// ignore
	}
	if (cwd) {
		try {
			if (existsSync(resolve(cwd, candidate))) return true;
		} catch {
			// ignore
		}
	}
	return false;
}

/**
 * Build the set of `/`-normalized, deduplicated paths the compaction knows the
 * model actually touched (read or modified). The lists are already cwd-stripped
 * by `computeOperationLists`, so this is a normalization pass for safety.
 */
function buildGroundedSet(lists: OperationLists): Set<string> {
	const set = new Set<string>();
	for (const p of lists.readFiles) set.add(normalizeSep(p));
	for (const p of lists.modifiedFiles) set.add(normalizeSep(p));
	return set;
}

/**
 * Ground every path-like token in `summary` against the operation lists and the
 * filesystem. Ungrounded paths are annotated `(unverified)` on their FIRST
 * occurrence only (later repeats pass through unchanged) and reported via a
 * `compaction.summary-ungrounded` diagnostic. No-op when
 * `PIT_NO_SUMMARY_GROUNDING` is set, or when the prose carries no path tokens.
 *
 * `Message` is imported alongside `recordDiagnostic` to keep the @pit/ai import
 * shape identical to the rest of the compaction package; it is not used at
 * runtime here.
 */
export function groundSummaryPaths(summary: string, lists: OperationLists, cwd: string | undefined): GroundedSummary {
	if (isTruthyEnvFlag(process.env.PIT_NO_SUMMARY_GROUNDING)) {
		return { summary, ungroundedPaths: [] };
	}
	const grounded = buildGroundedSet(lists);
	const seen = new Set<string>();
	const ungroundedPaths: string[] = [];

	const annotated = summary.replace(PATH_TOKEN_RE, (match) => {
		const normalized = normalizeSep(match);
		if (seen.has(normalized)) return match; // annotate first occurrence only
		seen.add(normalized);
		if (isGrounded(normalized, grounded, cwd)) return match;
		ungroundedPaths.push(match);
		return `${match}${UNGROUNDED_MARKER}`;
	});

	if (ungroundedPaths.length > 0) {
		recordDiagnostic({
			category: "compaction.summary-ungrounded",
			level: "warn",
			source: "compaction.groundSummaryPaths",
			context: {
				note: `ungrounded=${ungroundedPaths.length} paths=${ungroundedPaths.slice(0, 8).join(",")}`,
			},
		});
	}

	return { summary: annotated, ungroundedPaths };
}
