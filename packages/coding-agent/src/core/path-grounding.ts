/**
 * Path Grounding — pre-execution grounding of a tool's FILE-PATH argument.
 *
 * PURE, decoupled pre-execution logic. When a tool REFERENCES a file that must
 * already exist (`read`, `edit`) but the path doesn't resolve on disk AND there
 * is a close-named sibling in the target directory, it returns:
 *
 *   (1) the path resolves / nothing groundable        -> { action: "allow" }
 *   (2) the path is missing AND a close filename
 *       candidate exists in its directory             -> { action: "block", message }
 *
 * This is the file-path sibling of the symbol- and import-grounding guards (same
 * fuzzy candidate engine), closing the symbol / import / path trio.
 *
 * THREE LOAD-BEARING INVARIANTS:
 *
 *   - FAIL-OPEN absolutely. Any throw / unlistable dir / glob pattern / empty
 *     path -> { action: "allow" }. A guard that can't prove a path is missing
 *     must never block a legitimate reference.
 *
 *   - REFERENCE-only. Only tools that READ an existing file are grounded; `write`
 *     (which CREATES a file) is never grounded — a non-existent path there is the
 *     intent, not a typo. The adapter scopes this to read/edit.
 *
 *   - BLOCK-only, never auto-fix. Unlike the symbol guard, we never rewrite the
 *     path arg: silently retargeting to a real-but-different file would make the
 *     tool read/edit the WRONG file — strictly worse than an error. We only block
 *     with the candidate and let the model choose.
 *
 * This module touches NO agent-session / registries / hubs. It only takes
 * injectable deps (resolve / fileExists / listDir / fuzzy). The wiring lives in
 * the thin adapter (path-grounding-extension.ts).
 */

// ============================================================================
// Public verdict / input shapes
// ============================================================================

/** Verdict returned by `groundPath`. BLOCK-only: never rewrites the path arg. */
export type PathGroundingDecision = { action: "allow" } | { action: "block"; message: string };

/** The raw path argument as the tool received it (relative or absolute). */
export interface PathGroundingInput {
	path: string;
}

// ============================================================================
// Injectable dependencies (real defaults wired by the adapter)
// ============================================================================

/** Resolve a raw path to an absolute fs path (adapter injects resolveToolPath bound to cwd). */
export type ResolvePath = (rawPath: string) => string;
/** True iff `absPath` exists on disk (file OR directory). Defaults to fs.existsSync. */
export type FileExists = (absPath: string) => boolean;
/** Names of the directory entries at `absDir` (basenames), or throws if unlistable. */
export type ListDir = (absDir: string) => string[];
/** Closest-name matcher (same `suggestClosest` from @pit/ai the other guards use). */
export type FuzzyClosest = (
	name: string,
	candidates: string[],
	options: { maxDistance: number; prefixMinOverlap: number },
) => string | undefined;
/**
 * Top-N variant of {@link FuzzyClosest} (same `suggestClosestN` from @pit/ai).
 * Returns up to `limit` best candidates, best-first, with IDENTICAL scoring/order
 * to calling {@link FuzzyClosest} repeatedly and removing each pick. OPTIONAL: when
 * wired, `rankCandidates` ranks in a single pass instead of re-scanning the pool
 * per pick; when omitted, the per-pick `fuzzy` loop is used (identical result).
 */
export type FuzzyClosestN = (
	name: string,
	candidates: string[],
	options: { maxDistance: number; prefixMinOverlap: number },
	limit: number,
) => string[];

export interface PathGroundingDeps {
	resolve: ResolvePath;
	fileExists: FileExists;
	listDir: ListDir;
	fuzzy: FuzzyClosest;
	/** OPTIONAL single-pass top-N matcher (suggestClosestN); falls back to `fuzzy` loop. */
	fuzzyN?: FuzzyClosestN;
	maxDistance: number;
	prefixMinOverlap: number;
}

// ============================================================================
// Tuning
// ============================================================================

/** Calibrated to the same "did you mean" tuning as the symbol/import guards. */
const DEFAULT_MAX_DISTANCE = 3;
/**
 * DISABLES suggestClosest's affix (substring) fallback for filenames — see the
 * import guard for the rationale (a value larger than any real basename makes the
 * `shorter.length < prefixMinOverlap` guard always trip, so only true edit-distance
 * typos qualify, never `app` -> `app.test`).
 */
const DEFAULT_PREFIX_MIN_OVERLAP = 64;
/** Cap the candidate list in a block message so a noisy dir can't flood it. */
const MAX_BLOCK_CANDIDATES = 5;

/** Default fuzzy threshold/overlap, exported so the adapter stays in sync. */
export const PATH_GROUNDING_DEFAULTS = {
	maxDistance: DEFAULT_MAX_DISTANCE,
	prefixMinOverlap: DEFAULT_PREFIX_MIN_OVERLAP,
} as const;

/** Glob/brace magic chars — a path carrying any of these is a pattern, not a literal file. */
const GLOB_MAGIC = /[*?[\]{}]/;

// ============================================================================
// Candidate ranking for a missing path
// ============================================================================

/**
 * Build the close-candidate list for a missing `rawPath`. We split off its parent
 * directory, list that dir, and fuzzy-rank the entries against the missing
 * basename — using the FULL basename WITH extension (config.json and config.yaml
 * are different files, unlike module specifiers where the extension is implicit).
 * The original directory prefix is re-attached so each suggestion is a usable path.
 * Returns [] when the dir can't be listed or nothing is close (caller -> allow).
 */
function rankCandidates(rawPath: string, deps: PathGroundingDeps): string[] {
	// Normalize the separator only for SPLITTING; keep the original prefix verbatim
	// in the suggestion so we don't flip a model's `/` into `\` or vice versa.
	const norm = rawPath.replace(/\\/g, "/");
	const lastSlash = norm.lastIndexOf("/");
	const dirPart = lastSlash >= 0 ? rawPath.slice(0, lastSlash) : ".";
	const wanted = norm.slice(lastSlash + 1);
	if (wanted.length === 0) return [];

	const absDir = deps.resolve(dirPart);
	let entries: string[];
	try {
		entries = deps.listDir(absDir);
	} catch {
		return [];
	}
	if (entries.length === 0) return [];

	const pool = entries.filter((entry) => entry.length > 0 && entry !== wanted);
	const prefix = lastSlash >= 0 ? rawPath.slice(0, lastSlash + 1) : "";

	const closest = rankBasenames(wanted, pool, deps);
	return closest.map((name) => `${prefix}${name}`);
}

/**
 * Rank up to {@link MAX_BLOCK_CANDIDATES} basenames against `wanted`, best-first.
 * Uses the single-pass `fuzzyN` when wired; otherwise the per-pick `fuzzy` loop
 * (pick closest, drop it, repeat). Both return the IDENTICAL top-N ordering —
 * `fuzzyN` IS `suggestClosestN`, whose stable ascending-score sort matches the
 * loop's repeated `< best.score` selection.
 */
function rankBasenames(wanted: string, pool: string[], deps: PathGroundingDeps): string[] {
	const options = { maxDistance: deps.maxDistance, prefixMinOverlap: deps.prefixMinOverlap };
	const fuzzyN = deps.fuzzyN;
	if (fuzzyN !== undefined) {
		return fuzzyN(wanted, pool, options, MAX_BLOCK_CANDIDATES);
	}
	const ranked: string[] = [];
	let remaining = pool;
	while (remaining.length > 0 && ranked.length < MAX_BLOCK_CANDIDATES) {
		const closest = deps.fuzzy(wanted, remaining, options);
		if (closest === undefined) break;
		ranked.push(closest);
		remaining = remaining.filter((entry) => entry !== closest);
	}
	return ranked;
}

/** Block message in the established tool-error-hint tone (matches the other guards). */
function formatBlockMessage(rawPath: string, candidates: string[]): string {
	const list = candidates.join(", ");
	return (
		`Path grounding (no read/edit attempted): "${rawPath}" does not exist on disk. ` +
		`Did you mean: ${list}? Use the correct path, ` +
		"or re-issue the identical call to run it anyway."
	);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Ground a single file-path arg. Pure: all fs access is via injected deps.
 * Returns:
 *   - { action: "allow" }            — resolves / glob / empty / fail-open
 *   - { action: "block", message }   — missing path + close candidates
 */
export function groundPath(input: PathGroundingInput, deps: PathGroundingDeps): PathGroundingDecision {
	try {
		const { path } = input;
		if (typeof path !== "string" || path.length === 0) return { action: "allow" };
		// A glob/brace pattern is not a literal file path — leave it alone.
		if (GLOB_MAGIC.test(path)) return { action: "allow" };

		if (deps.fileExists(deps.resolve(path))) return { action: "allow" };

		const candidates = rankCandidates(path, deps);
		if (candidates.length === 0) return { action: "allow" };
		return { action: "block", message: formatBlockMessage(path, candidates) };
	} catch {
		return { action: "allow" };
	}
}

// ============================================================================
// Opt-out
// ============================================================================

/** Opt-out: PIT_NO_PATH_GROUNDING disables path grounding entirely (FAIL-OPEN). */
export function isPathGroundingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PIT_NO_PATH_GROUNDING;
	if (!value) return false;
	const v = value.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

/* ============================================================================
 * WIRING (performed by the thin adapter + built-ins registry)
 * ============================================================================
 *
 * 1. NEW FILE — packages/coding-agent/src/core/built-ins/path-grounding-extension.ts
 *    (thin adapter; keeps THIS module pure). It:
 *      - gates `event.toolName === "read" || "edit"` only (NEVER write),
 *      - reads the path via extractPathArg (argument-prep.ts:169),
 *      - wires resolve = (p) => resolveToolPath(p, cwd) (argument-prep.ts:184),
 *        fileExists = fs.existsSync, listDir = fs.readdirSync, fuzzy = suggestClosest,
 *      - wraps the WHOLE handler in try/catch (emitToolCall has no per-handler
 *        isolation; fail-open is load-bearing),
 *      - fire-once anti-wedge: a verbatim re-issue of a blocked call runs,
 *      - opt-out PIT_NO_PATH_GROUNDING.
 *
 * 2. REGISTER — packages/coding-agent/src/core/built-ins/index.ts factories array,
 *    after createImportGroundingExtension, before createHooksExtension:
 *      createPathGroundingExtension({ cwd: options.cwd }),
 *
 * agent-session.ts already bridges beforeToolCall -> runner.emitToolCall and
 * short-circuits on the first block; no change there.
 * ========================================================================== */
