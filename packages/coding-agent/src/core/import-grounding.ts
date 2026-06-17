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
 *   - RELATIVE + BARE, BLOCK-only. Relative specifiers ("./", "../") are grounded
 *     against the filesystem; BARE package specifiers ("react", "@scope/x") are
 *     grounded against the project's known packages + Node builtins (when the
 *     `knownPackages` dep is wired). ALIAS specifiers ("@/x", "~/x") and
 *     `#imports`-map subpaths ALLOW untouched — resolving those needs tsconfig
 *     paths / package `imports`, the monorepo false-block hotspot, out of scope.
 *     We NEVER rewrite the content; we only block with a suggestion.
 *
 * This module touches NO agent-session / registries / hubs. It only takes
 * injectable deps (fileExists / listDir / fuzzy), each with a real default wired
 * by the thin adapter. The wiring is documented in the WIRING block at the end.
 */

import { builtinModules } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";

// ============================================================================
// Public verdict / input shapes
// ============================================================================

/**
 * Verdict returned by `groundImports`. BLOCK-only: never rewrites content.
 * The block branch carries `kind` ("path" = unresolved relative module,
 * "bare" = unknown package specifier, "export" = unexported named binding) for
 * downstream telemetry.
 */
export type ImportGroundingDecision =
	| { action: "allow" }
	| { action: "block"; kind: "path" | "export" | "bare"; message: string };

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
	/**
	 * Read a resolved module's source so its EXPORTS can be enumerated for
	 * named-export validation (the second pass below). OPTIONAL: when omitted,
	 * export validation is skipped entirely and only the import-path resolution
	 * pass runs (preserves the original contract for callers that don't wire fs
	 * reads). Returns undefined when the file can't be read -> that module is
	 * skipped (fail-open). Defaults to fs.readFileSync in the adapter.
	 */
	readFile?: (absPath: string) => string | undefined;
	/**
	 * The set of package names the project may legitimately import — the union of
	 * dependencies + devDependencies + peerDependencies (+ workspace package names
	 * in a monorepo). Wired by the adapter from the project's package.json(s).
	 * OPTIONAL: when omitted (mirroring `readFile`), the BARE-package pass is
	 * skipped entirely (fail-open). An empty set is harmless — a bare specifier
	 * with no close known-package name is always ALLOWED.
	 */
	knownPackages?: () => Set<string>;
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
 * Anchoring at `^[ \t]*(import|export)` (multiline) is what keeps the extractor
 * OUT of comments (`// import …`), string and template literals: a line starting
 * with `const x = "import …"` begins with `const`, not `import`. We use `[ \t]`
 * (not `\s`) for the leading indent so `^` truly anchors at the START of a line —
 * `\s` would swallow the preceding newline and let the anchor drift mid-content.
 *
 * MULTI-LINE imports ARE matched: the clause between `import`/`export` and `from`
 * may span lines (`import {\n  a,\n  b,\n} from "X"`), so `\n` is REMOVED from the
 * clause negation (`[^'"]*?`), but the clause still stops at a quote (the next
 * specifier) and is non-greedy. The specifier groups keep `[^'"\n]+` (a path never
 * spans a line). `require()` and dynamic `import()` are intentionally NOT matched
 * in v1 — they carry no line anchor and commonly appear inside codegen
 * strings/templates (false positives).
 *
 * LIMITATION (accepted, fail-open + fire-once cover it): an `import … from "…"`
 * whose FIRST line starts inside a `/* … *\/` block comment can match (we do NOT
 * strip comments). A line-comment (`// import …`) never starts with `import`, so
 * it is still excluded by the `^[ \t]*` anchor.
 *
 * Three capture groups: import-from, side-effect import, export-from.
 */
const IMPORT_SPECIFIER_RE =
	/^[ \t]*(?:import\b[^'"]*?\bfrom\s*['"]([^'"\n]+)['"]|import\s*['"]([^'"\n]+)['"]|export\b[^'"]*?\bfrom\s*['"]([^'"\n]+)['"])/gm;

/** A specifier is RELATIVE iff it starts with "./" or "../". Bare/alias -> not ours. */
function isRelativeSpecifier(spec: string): boolean {
	return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * A specifier is an ALIAS iff it starts with "@/" (empty scope before the slash)
 * or "~/" — the tsconfig-`paths` / bundler conventions. Aliases are OUT OF SCOPE
 * for bare-package grounding (resolving them needs tsconfig, the monorepo's
 * false-block hotspot). NOTE: "@scope/pkg" is a real scoped package (BARE), not an
 * alias — only the empty-scope "@/" form is.
 */
function isAliasSpecifier(spec: string): boolean {
	return spec.startsWith("@/") || spec.startsWith("~/");
}

/** Node builtins (without the `node:` prefix), e.g. "fs", "path", "fs/promises". */
const NODE_BUILTINS = new Set<string>(builtinModules);

/**
 * True iff `spec` names a Node builtin: the `node:` prefix is ALWAYS a builtin
 * (node:fs, node:test), and an un-prefixed name is a builtin when it (or its
 * first path segment, for "fs/promises") is in {@link NODE_BUILTINS}.
 */
function isNodeBuiltin(spec: string): boolean {
	if (spec.startsWith("node:")) return true;
	if (NODE_BUILTINS.has(spec)) return true;
	const slash = spec.indexOf("/");
	const firstSegment = slash >= 0 ? spec.slice(0, slash) : spec;
	return NODE_BUILTINS.has(firstSegment);
}

/**
 * Reduce a bare specifier to the PACKAGE name a dependency manifest lists:
 *   `@scope/pkg/sub` -> `@scope/pkg` (scope + first segment)
 *   `pkg/sub/path`   -> `pkg`        (first segment)
 *   `pkg`            -> `pkg`
 */
function barePackageName(spec: string): string {
	if (spec.startsWith("@")) {
		const parts = spec.split("/");
		return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
	}
	const slash = spec.indexOf("/");
	return slash >= 0 ? spec.slice(0, slash) : spec;
}

/**
 * Extract every UNIQUE BARE specifier from `content`, in first-seen order. A bare
 * specifier is a package import: NOT relative (`./`, `../`), NOT an alias (`@/`,
 * `~/`), and NOT a Node `imports`-map subpath (`#internal`). Scoped packages
 * (`@scope/pkg`) ARE bare. Aliases/relative/imports-map are dropped (out of
 * scope for package grounding).
 */
function extractBareSpecifiers(content: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	IMPORT_SPECIFIER_RE.lastIndex = 0;
	let match: RegExpExecArray | null = IMPORT_SPECIFIER_RE.exec(content);
	while (match !== null) {
		const spec = match[1] ?? match[2] ?? match[3];
		if (
			spec !== undefined &&
			!isRelativeSpecifier(spec) &&
			!isAliasSpecifier(spec) &&
			!spec.startsWith("#") &&
			!seen.has(spec)
		) {
			seen.add(spec);
			out.push(spec);
		}
		match = IMPORT_SPECIFIER_RE.exec(content);
	}
	return out;
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
 * Returns the ABSOLUTE resolved path of the first candidate that exists, or null
 * when nothing resolves. (Returning the path — not just a boolean — lets the
 * export-validation pass read the very module it resolved to.)
 */
function resolveModulePath(fromDir: string, specifier: string, fileExists: FileExists): string | null {
	const base = resolvePath(fromDir, specifier);
	if (fileExists(base)) return base;
	// NodeNext/ESM: a `.js/.jsx/.mjs/.cjs` specifier resolves to its TS source on
	// disk (import "./x.js" -> x.ts). Try the TS-family sibling before giving up,
	// so a correct ESM import isn't false-blocked.
	const jsExt = base.match(/\.(?:js|jsx|mjs|cjs)$/i);
	if (jsExt) {
		const stem = base.slice(0, base.length - jsExt[0].length);
		for (const ext of [".ts", ".tsx", ".mts", ".cts"]) {
			if (fileExists(stem + ext)) return stem + ext;
		}
	}
	for (const ext of RESOLVE_EXTENSIONS) {
		if (fileExists(base + ext)) return base + ext;
	}
	for (const ext of RESOLVE_EXTENSIONS) {
		const indexPath = resolvePath(base, `index${ext}`);
		if (fileExists(indexPath)) return indexPath;
	}
	return null;
}

/** True iff the relative `specifier` resolves to any module on disk. */
function resolvesOnDisk(fromDir: string, specifier: string, fileExists: FileExists): boolean {
	return resolveModulePath(fromDir, specifier, fileExists) !== null;
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
// Named-export validation
// ----------------------------------------------------------------------------
// Pass 1 (above) proves the MODULE exists. Pass 2 (below) proves the NAMED
// BINDINGS a `import { foo } from "./mod"` asks for are actually exported by
// that module — the second-most-common codegen error after a wrong path: a
// named import of a symbol the module never exports (or a typo of one it does).
//
// SAME block-only / fail-open posture as the path pass, plus extra restraint:
//   - LINE-ANCHORED imports (single- OR multi-line). The clause between `import`
//     and `from` may span lines (`import {\n a,\n b,\n} from`); only the line-start
//     anchor + quote/`;` bounds keep it out of comments/strings.
//   - NAMED bindings only. Default (`import x from`) and namespace (`import * as`)
//     imports are NOT validated — proving a default/namespace absent is far more
//     false-positive prone (`export { x as default }`, dynamic namespace use).
//   - If the module has a bare `export * from "..."` re-export, its full export
//     set is NOT enumerable from this file alone -> the module is SKIPPED (we can
//     never prove a name is absent through a wildcard).
//   - BLOCK only when a close export name exists (fuzzy, same threshold as the
//     path pass) — a genuinely-absent binding with NO near name is ALLOWED, since
//     our regex export parser may not capture every exotic re-export form.
// ============================================================================

/** Parsed bindings of ONE `import … from "spec"` statement (single- or multi-line). */
interface ParsedImport {
	specifier: string;
	/**
	 * Names imported BY NAME — the source-module name (the part BEFORE any `as`,
	 * since `import { a as b }` pulls export `a`). Excludes `default` and the
	 * namespace form. These are what we validate against the module's exports.
	 */
	named: string[];
}

/**
 * Match a static import that has a `from` clause, anchored at line start
 * (`^[ \t]*`, NOT `^\s*` — `\s` would let the anchor drift past a newline). The
 * binding clause `[^'";]*?` forbids quote/semicolon (so it stays within ONE
 * statement and can't run into the next import's specifier) but ALLOWS newlines,
 * so a MULTI-LINE `import {\n  a,\n  b,\n} from "X"` is captured. `parseNamed
 * Bindings` splits the `{ … }` on commas and trims each entry, so embedded
 * newlines inside the binding list are harmless. Group 1 = clause, group 2 = spec.
 */
const IMPORT_CLAUSE_RE = /^[ \t]*import\b([^'";]*?)\bfrom\s*['"]([^'"\n]+)['"]/gm;

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;

/** Extract the source-module names from a `{ … }` binding clause. */
function parseNamedBindings(clause: string): string[] {
	const open = clause.indexOf("{");
	const close = clause.indexOf("}", open + 1);
	if (open < 0 || close < 0) return [];
	const out: string[] = [];
	for (const rawEntry of clause.slice(open + 1, close).split(",")) {
		let entry = rawEntry.trim();
		if (entry.length === 0) continue;
		// Inline type import marker: `import { type Foo }` imports type export Foo.
		if (entry.startsWith("type ")) entry = entry.slice(5).trim();
		// `a as b` imports export `a` (validate the source name, before `as`).
		const asIdx = entry.search(/\bas\b/);
		const sourceName = (asIdx >= 0 ? entry.slice(0, asIdx) : entry).trim();
		if (sourceName === "default") continue; // default import via named syntax — not validated
		if (IDENT_RE.test(sourceName)) out.push(sourceName);
	}
	return out;
}

/** Parse every line-anchored import with named bindings into {specifier, named} (single- or multi-line). */
function parseImports(content: string): ParsedImport[] {
	const out: ParsedImport[] = [];
	IMPORT_CLAUSE_RE.lastIndex = 0;
	let match: RegExpExecArray | null = IMPORT_CLAUSE_RE.exec(content);
	while (match !== null) {
		const clause = match[1] ?? "";
		const specifier = match[2];
		if (specifier !== undefined) {
			const named = parseNamedBindings(clause);
			if (named.length > 0) out.push({ specifier, named });
		}
		match = IMPORT_CLAUSE_RE.exec(content);
	}
	return out;
}

/** The enumerable named exports of a module + whether a wildcard re-export defeats enumeration. */
interface ModuleExports {
	names: Set<string>;
	/** A bare `export * from "…"` — the export set is NOT fully knowable from this file. */
	wildcard: boolean;
}

/** Declaration exports: `export [declare] [async] [abstract] <kw> NAME`. NO `default` (a default is not a named export). */
const EXPORT_DECL_RE =
	/^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:const\s+enum|const|let|var|function\*?|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;

/** `export { a, b as c, type T }` lists (may span lines — `[^}]` allows newlines). */
const EXPORT_LIST_RE = /export\s*\{([^}]*)\}/g;

/** `export * as ns from "…"` — exports the single namespace binding `ns` (NOT a wildcard). */
const EXPORT_STAR_AS_RE = /^\s*export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/gm;

/** `export * from "…"` (no `as`) — a true wildcard that defeats enumeration. */
const EXPORT_STAR_BARE_RE = /^\s*export\s+\*\s+from\s*['"][^'"\n]+['"]/m;

/**
 * Enumerate a module's NAMED exports from its source. Best-effort by regex:
 * declarations, `export { … }` lists (incl. re-exports & renames), and
 * `export * as ns`. A bare `export *` sets `wildcard` (caller then skips).
 * `export default …` is intentionally NOT collected.
 */
function extractExports(source: string): ModuleExports {
	const names = new Set<string>();
	const wildcard = EXPORT_STAR_BARE_RE.test(source);

	EXPORT_DECL_RE.lastIndex = 0;
	for (let m = EXPORT_DECL_RE.exec(source); m !== null; m = EXPORT_DECL_RE.exec(source)) {
		if (m[1] !== undefined) names.add(m[1]);
	}

	EXPORT_LIST_RE.lastIndex = 0;
	for (let m = EXPORT_LIST_RE.exec(source); m !== null; m = EXPORT_LIST_RE.exec(source)) {
		for (const rawEntry of (m[1] ?? "").split(",")) {
			let entry = rawEntry.trim();
			if (entry.length === 0) continue;
			if (entry.startsWith("type ")) entry = entry.slice(5).trim();
			// The EXPORTED name is AFTER `as` (`internal as Public` exports `Public`).
			const asIdx = entry.search(/\bas\b/);
			const exportedName = (asIdx >= 0 ? entry.slice(asIdx + 2) : entry).trim();
			if (exportedName === "default") continue; // `x as default` — not importable by name
			if (IDENT_RE.test(exportedName)) names.add(exportedName);
		}
	}

	EXPORT_STAR_AS_RE.lastIndex = 0;
	for (let m = EXPORT_STAR_AS_RE.exec(source); m !== null; m = EXPORT_STAR_AS_RE.exec(source)) {
		if (m[1] !== undefined) names.add(m[1]);
	}

	return { names, wildcard };
}

/** Block message for a named import whose symbol the module does not export. */
function formatExportBlockMessage(specifier: string, name: string, candidate: string): string {
	return (
		`Import grounding (no write attempted): "${specifier}" has no exported member "${name}". ` +
		`Did you mean: ${candidate}? Fix the import name, ` +
		"or re-issue the identical call to write it anyway."
	);
}

/**
 * Pass 2: for each line-anchored named import whose module RESOLVES, verify every
 * named binding is exported. Returns the first BLOCK (an unexported name with a
 * close candidate) or null. Pure — all fs access via injected `deps`.
 */
function validateNamedExports(
	fromDir: string,
	content: string,
	deps: ImportGroundingDeps,
): ImportGroundingDecision | null {
	const readFile = deps.readFile;
	if (readFile === undefined) return null; // export validation not wired -> skip
	for (const imp of parseImports(content)) {
		if (!isRelativeSpecifier(imp.specifier)) continue;
		if (hasNonGroundableExtension(imp.specifier)) continue;
		const resolved = resolveModulePath(fromDir, imp.specifier, deps.fileExists);
		if (resolved === null) continue; // unresolved is pass 1's job (or fail-open)
		const source = readFile(resolved);
		if (source === undefined) continue; // unreadable -> fail-open for this module
		const exports = extractExports(source);
		if (exports.wildcard) continue; // wildcard re-export -> can't prove absence
		if (exports.names.size === 0) continue; // nothing enumerable -> fail-open
		const exportList = [...exports.names];
		for (const name of imp.named) {
			if (exports.names.has(name)) continue;
			const candidate = deps.fuzzy(name, exportList, {
				maxDistance: deps.maxDistance,
				prefixMinOverlap: deps.prefixMinOverlap,
			});
			// Block only on a close candidate; a genuinely-absent name with no near
			// match is ALLOWED (the regex parser may miss an exotic re-export form).
			if (candidate !== undefined) {
				return {
					action: "block",
					kind: "export",
					message: formatExportBlockMessage(imp.specifier, name, candidate),
				};
			}
		}
	}
	return null;
}

// ============================================================================
// Bare-package validation
// ----------------------------------------------------------------------------
// A BARE specifier (`react`, `@scope/x`, `lodash/fp`) imports a package, not a
// file on disk. We can still ground it cheaply: its package name must be either a
// Node builtin or a name the project declares (dependencies + devDependencies +
// peerDependencies, plus workspace package names in a monorepo). When it is
// neither AND a close known-package name exists, that is a missing/typo'd
// dependency (`lodash-es` -> `lodash`) we block one round-trip before the install
// or type-check fails. SAME block-only / fail-open posture as the path pass:
//   - ALIAS specifiers (`@/x`, `~/x`) and `#imports`-map subpaths are NOT bare —
//     resolving those needs tsconfig/package `imports`, explicitly out of scope.
//   - OPTIONAL `knownPackages` dep: omitted -> the whole pass is skipped.
//   - NO close known-package name -> ALLOWED (a genuinely new package the model
//     is about to install has no near neighbour; we never wedge it).
// ============================================================================

/** Block message for a bare import whose package is not a known dependency. */
function formatBareBlockMessage(packageName: string, candidate: string): string {
	return (
		`Import grounding (no write attempted): package "${packageName}" is not in the project's ` +
		`dependencies. Did you mean: ${candidate}? Install it or fix the package name, ` +
		"or re-issue the identical call to write it anyway."
	);
}

/**
 * Validate every BARE import specifier against the project's known packages +
 * Node builtins. Returns the FIRST block (an unknown package with a close known
 * name) or null. Pure — the known-package set is supplied via injected `deps`.
 */
function validateBarePackages(content: string, deps: ImportGroundingDeps): ImportGroundingDecision | null {
	const knownPackages = deps.knownPackages;
	if (knownPackages === undefined) return null; // bare grounding not wired -> skip
	const known = knownPackages();
	const candidates = Array.from(known);
	for (const spec of extractBareSpecifiers(content)) {
		if (isNodeBuiltin(spec)) continue; // builtins are always valid
		const packageName = barePackageName(spec);
		if (known.has(packageName)) continue; // declared dependency / workspace package
		// Unknown package: only block when a close known name exists (a typo of a
		// real dep). No near match -> ALLOW (fail-open, same as the path pass).
		const candidate = deps.fuzzy(packageName, candidates, {
			maxDistance: deps.maxDistance,
			prefixMinOverlap: deps.prefixMinOverlap,
		});
		if (candidate === undefined) continue;
		return { action: "block", kind: "bare", message: formatBareBlockMessage(packageName, candidate) };
	}
	return null;
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

		// Pass 1 — the MODULE must resolve. A wrong path is more fundamental than a
		// wrong member, so it is reported first and short-circuits.
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
			return { action: "block", kind: "path", message: formatBlockMessage(specifier, candidates) };
		}

		// Bare-package pass — a package import (`react`, `@scope/x`) whose name is
		// neither a Node builtin nor a known project dependency, but is a close typo of
		// one, is blocked. Disjoint from the relative passes (different specifier set).
		// Only runs when `knownPackages` is wired; fail-open everywhere else.
		const bareDecision = validateBarePackages(content, deps);
		if (bareDecision !== null) return bareDecision;

		// Pass 2 — every named binding must be exported by its (resolved) module.
		// Only runs when a `readFile` dep is wired; fail-open everywhere else.
		const exportDecision = validateNamedExports(fromDir, content, deps);
		if (exportDecision !== null) return exportDecision;

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
