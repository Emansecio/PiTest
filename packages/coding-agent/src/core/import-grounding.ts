/**
 * Import Grounding — pre-execution grounding of RELATIVE import paths.
 *
 * PURE, decoupled pre-execution logic. Given a file about to be written/edited
 * (`targetFile` + the NEW `content` being written), it extracts every RELATIVE
 * static import/export specifier, resolves each against the real filesystem, and
 * returns one of two verdicts:
 *
 *   (1) every relative import resolves (or nothing groundable)  -> { action: "allow" }
 *   (2) a relative import does NOT resolve AND there are close
 *       filename candidates in the target dir                   -> { action: "block", message }
 *
 * This is the #1 real error vector in generated code: a wrong relative import
 * path. We BLOCK ONLY (never rewrite the user's code) with the close candidates,
 * leaving the model to re-issue the corrected specifier.
 *
 * THREE LOAD-BEARING INVARIANTS:
 *
 *   - FAIL-OPEN absolutely. Any throw / fs dep unavailable / unknown target path
 *     / unreadable content -> { action: "allow" }. A guard that can't prove a
 *     path is missing must never block a legitimate import. Same posture as the
 *     symbol grounding-guard and debug-verify.
 *
 *   - REFERENCE-only by nature. An import ALWAYS references an existing module —
 *     there is no "new definition" form to confuse it with (unlike a symbol
 *     name). So scanning the new content for imports never touches something the
 *     author is creating.
 *
 *   - RELATIVE paths only, BLOCK-only. Only specifiers starting with "./" or
 *     "../" are grounded (a real fs target exists for those at write time). Bare
 *     ("react", "@scope/x") and alias ("@/x", "~/x") specifiers ALLOW untouched —
 *     resolving those needs node_modules / tsconfig paths, out of scope for v1.
 *     We NEVER rewrite the content; we only block with a suggestion.
 *
 * This module touches NO agent-session / registries / hubs. It only takes
 * injectable deps (fileExists / listDir / fuzzy), each with a real default wired
 * by the thin adapter. The wiring is documented in the WIRING block at the end.
 */

import { dirname, resolve as resolvePath } from "node:path";

// ============================================================================
// Public verdict / input shapes
// ============================================================================

/** Verdict returned by `groundImports`. BLOCK-only: never rewrites content. */
export type ImportGroundingDecision = { action: "allow" } | { action: "block"; message: string };

/** The file being written + its new content, plus the injectable fs/fuzzy deps. */
export interface ImportGroundingInput {
	/** Absolute path of the file being written/edited (resolved by the adapter). */
	targetFile: string;
	/** The NEW content to scan for relative imports (full body, or concatenated newText). */
	content: string;
}

// ============================================================================
// Injectable dependencies (real defaults wired by the adapter)
// ============================================================================

/** True iff `absPath` exists on disk (a file). Defaults to fs.existsSync in the adapter. */
export type FileExists = (absPath: string) => boolean;

/** Names of the directory entries at `absDir` (basenames), or [] when it can't be listed. */
export type ListDir = (absDir: string) => string[];

/**
 * Closest-name matcher (same `suggestClosest` from `@pit/ai` the symbol guard
 * uses). Returns the single best candidate name, or `undefined`.
 */
export type FuzzyClosest = (
	name: string,
	candidates: string[],
	options: { maxDistance: number; prefixMinOverlap: number },
) => string | undefined;

export interface ImportGroundingDeps {
	/** Existence check for a fully-resolved candidate path. */
	fileExists: FileExists;
	/** List a directory's entries (basenames) for candidate ranking. */
	listDir: ListDir;
	/** Fuzzy matcher (defaults to suggestClosest from @pit/ai). */
	fuzzy: FuzzyClosest;
	/** Max edit distance for a candidate to qualify. */
	maxDistance: number;
	/** Min affix overlap for the fuzzy affix fallback. */
	prefixMinOverlap: number;
}

// ============================================================================
// Tuning
// ============================================================================

/**
 * Extensions tried (in order) when resolving a relative specifier, plus the
 * `/index.<ext>` directory form. Mirrors the node/TS resolution surface the
 * codebase actually uses (.ts/.tsx first since this is a TS monorepo).
 */
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;

/**
 * Extensions a relative specifier may legitimately carry as a code/data module
 * we can ground. A specifier ending in ANY other extension (.css/.svg/.png/.scss/
 * .module.css/…) is an ASSET the bundler/loader resolves — never on the node/TS
 * resolution surface — so grounding it would false-block with a wrong-type
 * suggestion (./logo.png for an `import "./logo.svg"`). Those pass through.
 */
const GROUNDABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".json"] as const;

/** True when the specifier's last segment carries an extension we do NOT ground (an asset). */
function hasNonGroundableExtension(spec: string): boolean {
	const lastSlash = spec.lastIndexOf("/");
	const base = lastSlash >= 0 ? spec.slice(lastSlash + 1) : spec;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return false; // no extension (./foo) or dotfile (./.keep) — not an asset
	const ext = base.slice(dot).toLowerCase();
	return !GROUNDABLE_EXTENSIONS.some((groundable) => groundable === ext);
}

/** Calibrated to the same "did you mean" tuning as the symbol grounding-guard. */
const DEFAULT_MAX_DISTANCE = 3;
/**
 * DISABLES suggestClosest's affix (substring) fallback for filenames. The fallback
 * returns a match beyond maxDistance whenever one name contains the other
 * (validation.ts:343-348) — for filenames that means `auth` -> `authentication`,
 * `index` -> `reindex`, a noisy false suggestion. A floor larger than any real
 * basename makes the `shorter.length < prefixMinOverlap` guard always trip, so
 * ONLY true edit-distance matches (typos like `utis` -> `utils`) qualify.
 */
const DEFAULT_PREFIX_MIN_OVERLAP = 64;
/** Cap the candidate list in a block message so a noisy dir can't flood it. */
const MAX_BLOCK_CANDIDATES = 5;

/** Default fuzzy threshold/overlap, exported so the adapter stays in sync. */
export const IMPORT_GROUNDING_DEFAULTS = {
	maxDistance: DEFAULT_MAX_DISTANCE,
	prefixMinOverlap: DEFAULT_PREFIX_MIN_OVERLAP,
} as const;

// ============================================================================
// Specifier extraction — the ONLY place content becomes "groundable"
// ============================================================================

/**
 * Match the specifier of a STATIC import/export anchored at the START of a line:
 *   - `import … from "X"`   / `import "X"` (side-effect)
 *   - `export … from "X"`   (re-export)
 *
 * Anchoring at `^\s*(import|export)` (multiline) is what keeps the extractor OUT
 * of comments (`// import …`), string and template literals: a line starting with
 * `const x = "import …"` begins with `const`, not `import`. `require()` and
 * dynamic `import()` are intentionally NOT matched in v1 — they carry no line
 * anchor and commonly appear inside codegen strings/templates (false positives).
 * Three capture groups: import-from, side-effect import, export-from.
 */
const IMPORT_SPECIFIER_RE =
	/^\s*(?:import\b[^'"\n]*?\bfrom\s*['"]([^'"\n]+)['"]|import\s*['"]([^'"\n]+)['"]|export\b[^'"\n]*?\bfrom\s*['"]([^'"\n]+)['"])/gm;

/** A specifier is RELATIVE iff it starts with "./" or "../". Bare/alias -> not ours. */
function isRelativeSpecifier(spec: string): boolean {
	return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * Extract every UNIQUE relative specifier from `content`, in first-seen order.
 * Non-relative specifiers (bare packages, `@/…`, `~/…`) are dropped here — they
 * are out of scope (need node_modules / tsconfig resolution).
 */
function extractRelativeSpecifiers(content: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	IMPORT_SPECIFIER_RE.lastIndex = 0;
	let match: RegExpExecArray | null = IMPORT_SPECIFIER_RE.exec(content);
	while (match !== null) {
		const spec = match[1] ?? match[2] ?? match[3];
		if (spec !== undefined && isRelativeSpecifier(spec) && !seen.has(spec)) {
			seen.add(spec);
			out.push(spec);
		}
		match = IMPORT_SPECIFIER_RE.exec(content);
	}
	return out;
}

// ============================================================================
// Resolution against the filesystem
// ============================================================================

/**
 * Resolve a relative `specifier` from `fromDir` against the fs, trying (in order):
 *   1. the exact path as written,
 *   2. the path + each known extension (.ts/.tsx/.js/.jsx/.mjs/.cjs/.json),
 *   3. the directory index form (`<path>/index.<ext>`).
 * Returns true iff ANY candidate exists (the import is valid).
 */
function resolvesOnDisk(fromDir: string, specifier: string, fileExists: FileExists): boolean {
	const base = resolvePath(fromDir, specifier);
	if (fileExists(base)) return true;
	// NodeNext/ESM: a `.js/.jsx/.mjs/.cjs` specifier resolves to its TS source on
	// disk (import "./x.js" -> x.ts). Try the TS-family sibling before giving up,
	// so a correct ESM import isn't false-blocked.
	const jsExt = base.match(/\.(?:js|jsx|mjs|cjs)$/i);
	if (jsExt) {
		const stem = base.slice(0, base.length - jsExt[0].length);
		for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
			if (fileExists(stem + ext)) return true;
		}
	}
	for (const ext of RESOLVE_EXTENSIONS) {
		if (fileExists(base + ext)) return true;
	}
	for (const ext of RESOLVE_EXTENSIONS) {
		if (fileExists(resolvePath(base, `index${ext}`))) return true;
	}
	return false;
}

// ============================================================================
// Candidate ranking for a broken specifier
// ============================================================================

/**
 * Strip a trailing known extension from a basename so the fuzzy match compares
 * the bare module name the model wrote (`utis`) against bare directory names
 * (`utils` for `utils.ts`). Leaves extensionless names untouched.
 */
function stripKnownExtension(basename: string): string {
	for (const ext of RESOLVE_EXTENSIONS) {
		if (basename.endsWith(ext)) return basename.slice(0, -ext.length);
	}
	return basename;
}

/**
 * Build the close-candidate list for a broken `specifier`. We resolve its parent
 * directory (the part before the last "/"), list that dir, and fuzzy-rank the
 * entries' bare names against the broken last segment. Returns candidate module
 * names best-first (deduped, capped). [] when the dir can't be listed or nothing
 * is close enough — the caller treats [] as ALLOW (fail-open, no wedge).
 */
function rankCandidates(fromDir: string, specifier: string, deps: ImportGroundingDeps): string[] {
	const lastSlash = specifier.lastIndexOf("/");
	// The directory the specifier points INTO, and the bare name it asks for.
	const specDir = lastSlash >= 0 ? specifier.slice(0, lastSlash) : ".";
	const wantedRaw = lastSlash >= 0 ? specifier.slice(lastSlash + 1) : specifier;
	const wanted = stripKnownExtension(wantedRaw);
	if (wanted.length === 0) return [];
	// Preserve the original specifier's extension style in the suggestion so it is
	// itself usable: ./configs.json for a .json import, ./helpers.js for a NodeNext
	// import, ./helpers for an extensionless one.
	const originalExt = wantedRaw.slice(wanted.length);

	const absDir = resolvePath(fromDir, specDir);
	let entries: string[];
	try {
		entries = deps.listDir(absDir);
	} catch {
		return [];
	}
	if (entries.length === 0) return [];

	// Bare-name pool: dedupe extensions (utils.ts + utils.test.ts -> utils, utils.test).
	const seen = new Set<string>();
	const pool: string[] = [];
	for (const entry of entries) {
		const bare = stripKnownExtension(entry);
		if (bare.length === 0 || bare === wanted || seen.has(bare)) continue;
		seen.add(bare);
		pool.push(bare);
	}

	const ranked: string[] = [];
	let remaining = pool;
	while (remaining.length > 0 && ranked.length < MAX_BLOCK_CANDIDATES) {
		const closest = deps.fuzzy(wanted, remaining, {
			maxDistance: deps.maxDistance,
			prefixMinOverlap: deps.prefixMinOverlap,
		});
		if (closest === undefined) break;
		// Re-attach the sub-directory prefix AND the original extension so the
		// suggestion is itself a usable specifier (`./sub/utils.js`, not bare `utils`).
		const prefix = specDir === "." ? "./" : `${specDir}/`;
		const suggestion = `${prefix}${closest}${originalExt}`;
		ranked.push(suggestion);
		remaining = remaining.filter((candidate) => candidate !== closest);
	}
	return ranked;
}

/**
 * Block message in the established tool-error-hint tone — the "(no write
 * attempted)" prefix used by edit-precondition and the canonical "Did you mean"
 * verb, ending with the fire-once escape phrasing the symbol guard uses.
 */
function formatBlockMessage(specifier: string, candidates: string[]): string {
	const list = candidates.join(", ");
	return (
		`Import grounding (no write attempted): relative import "${specifier}" does not resolve ` +
		`to any module on disk. Did you mean: ${list}? Fix the import path, ` +
		"or re-issue the identical call to write it anyway."
	);
}

// ============================================================================
// Main entry point
// ============================================================================

/**
 * Ground every RELATIVE import in `content` for the file at `targetFile`. Pure:
 * all fs access is via injected deps.
 *
 * Reports the FIRST broken relative import that has close candidates. A broken
 * import with NO close candidate falls through (the dir may legitimately not hold
 * a near-named file — we don't wedge a possibly-valid path we can't suggest a fix
 * for). Returns:
 *   - { action: "allow" }            — all resolve / none groundable / fail-open
 *   - { action: "block", message }   — first unresolved import + its candidates
 */
export function groundImports(input: ImportGroundingInput, deps: ImportGroundingDeps): ImportGroundingDecision {
	try {
		const { targetFile, content } = input;
		if (typeof targetFile !== "string" || targetFile.length === 0) return { action: "allow" };
		if (typeof content !== "string" || content.length === 0) return { action: "allow" };

		const fromDir = dirname(targetFile);
		const specifiers = extractRelativeSpecifiers(content);

		for (const specifier of specifiers) {
			// Assets (.css/.svg/.png/…) are bundler-resolved, not on the node/TS
			// resolution surface — skip so a near-named sibling never produces a
			// wrong-type suggestion (the #1 frontend false-positive).
			if (hasNonGroundableExtension(specifier)) continue;
			if (resolvesOnDisk(fromDir, specifier, deps.fileExists)) continue;
			// Unresolved: try to suggest. No candidate -> skip this one (fail-open),
			// keep scanning the rest.
			const candidates = rankCandidates(fromDir, specifier, deps);
			if (candidates.length === 0) continue;
			return { action: "block", message: formatBlockMessage(specifier, candidates) };
		}
		return { action: "allow" };
	} catch {
		// Any unexpected throw anywhere -> FAIL-OPEN.
		return { action: "allow" };
	}
}

// ============================================================================
// Opt-out
// ============================================================================

/** Opt-out: PIT_NO_IMPORT_GROUNDING disables import grounding entirely (FAIL-OPEN). */
export function isImportGroundingDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PIT_NO_IMPORT_GROUNDING;
	if (!value) return false;
	const v = value.toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

/* ============================================================================
 * WIRING (performed by the thin adapter + built-ins registry)
 * ============================================================================
 *
 * The adapter plugs in exactly like the symbol grounding-guard: a new
 * ExtensionFactory on the pre-exec `tool_call` event, scoped to write/edit.
 *
 * 1. NEW FILE — packages/coding-agent/src/core/built-ins/import-grounding-extension.ts
 *    (thin adapter; keeps THIS module pure). It:
 *      - gates `event.toolName === "write" || "edit"` only,
 *      - reads {targetFile, content} from event.input via the shared
 *        extractPathArg / resolveToolPath / extractEdits primitives
 *        (argument-prep.ts:169/184/203) — for `edit`, content = the concatenated
 *        edits[].newText (where a NEW import line lives),
 *      - wires fileExists = fs.existsSync, listDir = fs.readdirSync, fuzzy =
 *        suggestClosest (@pit/ai, validation.ts:332 via index.ts:52),
 *      - wraps the WHOLE handler in try/catch (emitToolCall has no per-handler
 *        isolation; fail-open is load-bearing),
 *      - fire-once anti-wedge: a verbatim re-issue of a blocked call runs,
 *      - opt-out PIT_NO_IMPORT_GROUNDING.
 *
 * 2. REGISTER — packages/coding-agent/src/core/built-ins/index.ts
 *    - import (alongside the others, around index.ts:26):
 *        import { createImportGroundingExtension } from "./import-grounding-extension.ts";
 *    - push into the `factories` array, immediately AFTER
 *      createGroundingGuardExtension (index.ts:97) and BEFORE createHooksExtension
 *      (index.ts:98), to keep "basic guards report first" ordering:
 *        createImportGroundingExtension({ cwd: options.cwd }),
 *
 * That is the ONLY wiring. agent-session.ts already bridges beforeToolCall ->
 * runner.emitToolCall and short-circuits on the first block; no change there.
 * ========================================================================== */
