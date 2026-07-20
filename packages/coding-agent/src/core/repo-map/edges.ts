/**
 * Repo Graph — edge extraction (import specifiers -> resolved repo-relative files).
 *
 * The Living Repo Map (`living-index.ts`) only had NODES (path -> symbols): no way
 * to answer "what breaks if I change this file" without grepping every importer by
 * hand. This module is the missing half: given one file's content + its own
 * repo-relative path, extract its import/require/use/mod specifiers and resolve
 * each to the repo-relative file it points at — but ONLY specifiers that actually
 * resolve on disk get returned (Invariant #6, "references are grounded before they
 * persist" — see docs/CONTEXT.md). An unresolved specifier (typo, external
 * package, `tsconfig` alias we don't model) is silently dropped: fail-open, zero
 * false "phantom dependent" edges from a broken import.
 *
 * No tree-sitter, no new dependency — regex extraction in the same heuristic style
 * as `tools/symbol.ts`, paired with best-effort resolution against an INJECTED
 * `fileExists` (so the caller controls I/O cost — see `living-index.ts`'s memoized
 * checker — and tests can drive exact filesystems without touching real disk).
 *
 * All path math uses `node:path`'s `posix` namespace (not the OS-default `path`)
 * because every path in/out of this module is repo-relative + forward-slash, the
 * same convention `RepoMapEntry.path` uses — `posix.*` keeps the resolution
 * deterministic across Windows/Linux instead of leaking backslashes.
 *
 * v1 language coverage (extension-dispatched):
 *   - TS/JS: `import ... from "X"` (incl. `import type`), `export ... from "X"`,
 *     side-effect `import "X"`, dynamic `import("X")`, `require("X")`. Relative
 *     specifiers ("./x", "../y") resolve against the filesystem; bare specifiers
 *     first go through the OPTIONAL injected `resolveBare` (workspace-map +
 *     tsconfig-paths resolver wired by `living-index.ts` — this is what resolves
 *     `@pit/agent-core` -> `packages/agent` and aliases like `@/x`), then fall
 *     back to the trivial monorepo mapping `@pit/<name>` ->
 *     `packages/<name>/src/index.*` (back-compat for harnesses that don't inject
 *     the resolver). Bare npm packages resolve through neither and are discarded.
 *   - Python: `import a.b.c` (incl. comma lists + `as` aliases) and
 *     `from a.b import d` (incl. relative `from . import x` / `from ..pkg import
 *     y`). Only the MODULE portion (`a.b`, never the imported names) is resolved,
 *     to `a/b.py` or `a/b/__init__.py`.
 *   - Rust: `mod name;` (same-dir `name.rs` / `name/mod.rs`), and
 *     `use crate::a::b` / `use super::x` / `use self::y` resolved best-effort
 *     against the nearest ancestor `src/` directory (`crate::`) or the current
 *     file's module directory (`self::`/`super::`). External-crate `use` is
 *     discarded.
 *
 * Fail-open by construction: `extractFileDeps` never throws — a parse/resolve
 * failure on one file just yields no deps for it, never breaks the reindex pass.
 */

import { posix } from "node:path";

/** Injectable existence check for a repo-relative (forward-slash) path. */
export interface EdgeResolveDeps {
	/** True iff `repoRelPath` exists on disk. Cheap/memoized by the caller. */
	fileExists: (repoRelPath: string) => boolean;
	/**
	 * OPTIONAL bare-specifier resolver: maps a non-relative TS/JS specifier
	 * (workspace package `@pit/agent-core`, tsconfig alias `@/x`) to a
	 * repo-relative forward-slash module path WITHOUT a guaranteed extension
	 * (e.g. `packages/agent/src/index`), or null when it models nothing for the
	 * specifier. The returned path still goes through the same extension/index
	 * cascade (`resolveTsJsModule`) against `fileExists` — so a wrong mapping
	 * yields no edge, never a phantom one. `fromRepoRelPath` is the IMPORTING
	 * file (aliases are governed by the tsconfig nearest to it). Wired by
	 * `living-index.ts` (workspace map + tsconfig paths); absent in older
	 * harnesses -> only the trivial `@pit/<name>` fallback below applies.
	 */
	resolveBare?: (specifier: string, fromRepoRelPath: string) => string | null;
}

/**
 * Extract + resolve every import/require/use/mod edge FROM `content` (the file at
 * `repoRelPath`, repo-relative + forward-slash). Dispatches by extension; unknown
 * extensions yield []. Result is deduplicated and sorted for a deterministic diff
 * against the persisted cache. Never throws.
 */
export function extractFileDeps(content: string, repoRelPath: string, deps: EdgeResolveDeps): string[] {
	try {
		const lower = repoRelPath.toLowerCase();
		let raw: string[];
		if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(lower)) {
			raw = extractTsJsDeps(content, repoRelPath, deps);
		} else if (/\.py$/.test(lower)) {
			raw = extractPythonDeps(content, repoRelPath, deps);
		} else if (/\.rs$/.test(lower)) {
			raw = extractRustDeps(content, repoRelPath, deps);
		} else {
			raw = [];
		}
		return Array.from(new Set(raw)).sort();
	} catch {
		return [];
	}
}

// ============================================================================
// TS / JS
// ============================================================================

/** Extensions tried, in order, for an extensionless relative specifier ("./x"). */
const TS_JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

/**
 * NodeNext/ESM convention this codebase itself uses (see `tools/symbol.ts`
 * importing `./path-utils.js` which resolves to `path-utils.ts` on disk): a
 * `.js`/`.jsx`/`.mjs`/`.cjs` specifier resolving to its TS source sibling. Tried
 * AFTER the literal specifier so a real `.js` file on disk still wins.
 */
const JS_TO_TS_SWAP: Record<string, string> = { ".js": ".ts", ".jsx": ".tsx", ".mjs": ".mts", ".cjs": ".cts" };

/**
 * Specifier extraction, one alternative per import form. Char-class clauses
 * (never `.`) so a multi-line `import {\n  a,\n} from "X"` is still matched, and
 * quotes/parens/semicolons bound each clause so it can't run into a neighboring
 * statement. Capture groups: 1=dynamic import(), 2=require(), 3=import...from,
 * 4=side-effect import, 5=export...from.
 */
const TS_JS_IMPORT_RE = new RegExp(
	[
		String.raw`\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)`,
		String.raw`\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)`,
		String.raw`\bimport\b[^'"();]*?\bfrom\s*["']([^"'\n]+)["']`,
		String.raw`\bimport\s*["']([^"'\n]+)["']`,
		String.raw`\bexport\b[^'"();]*?\bfrom\s*["']([^"'\n]+)["']`,
	].join("|"),
	"g",
);

/** Resolve a joined-but-unresolved module path (no known extension applied yet). */
function resolveTsJsModule(joined: string, fileExists: (p: string) => boolean): string | null {
	const normalized = posix.normalize(joined);
	const ext = posix.extname(normalized);
	if (ext.length > 0) {
		if (fileExists(normalized)) return normalized;
		const swapped = JS_TO_TS_SWAP[ext];
		if (swapped) {
			const candidate = normalized.slice(0, -ext.length) + swapped;
			if (fileExists(candidate)) return candidate;
		}
		return null;
	}
	for (const e of TS_JS_EXTENSIONS) {
		const candidate = normalized + e;
		if (fileExists(candidate)) return candidate;
	}
	for (const e of TS_JS_EXTENSIONS) {
		const candidate = posix.join(normalized, `index${e}`);
		if (fileExists(candidate)) return candidate;
	}
	return null;
}

/** True iff a workspace-scoped bare specifier is a bare `@pit/<name>` (no subpath). */
const WORKSPACE_SPEC_RE = /^@pit\/([a-z0-9-]+)$/;

/**
 * Resolve one TS/JS specifier to a repo-relative path, or null (bare npm package /
 * unresolved). Relative specifiers ("./", "../") resolve against `fileDir`,
 * exactly as before. Bare specifiers try the injected `resolveBare` FIRST (the
 * workspace-map + tsconfig-paths resolver wired by `living-index.ts` — the only
 * way `@pit/agent-core`, whose dir `packages/agent` doesn't match its name, or an
 * alias `@/x` can resolve). When `resolveBare` is absent, returns null, throws,
 * or maps to a path that doesn't exist on disk, the trivial `@pit/<name>` ->
 * `packages/<name>/src/index` guess still runs as the back-compat fallback.
 * Either way the mapped path goes through `resolveTsJsModule` (extension + index
 * + .js->.ts swap) so only on-disk files ever become edges.
 */
function resolveTsJsSpecifier(
	repoRelPath: string,
	fileDir: string,
	specifier: string,
	deps: EdgeResolveDeps,
): string | null {
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		return resolveTsJsModule(posix.join(fileDir, specifier), deps.fileExists);
	}
	if (deps.resolveBare) {
		try {
			const mapped = deps.resolveBare(specifier, repoRelPath);
			if (mapped !== null) {
				const resolved = resolveTsJsModule(mapped, deps.fileExists);
				if (resolved !== null) return resolved;
			}
		} catch {
			// fail-open: a resolver bug degrades to the trivial fallback below
		}
	}
	const workspaceMatch = WORKSPACE_SPEC_RE.exec(specifier);
	if (workspaceMatch) {
		return resolveTsJsModule(`packages/${workspaceMatch[1]}/src/index`, deps.fileExists);
	}
	return null;
}

export function extractTsJsDeps(content: string, repoRelPath: string, deps: EdgeResolveDeps): string[] {
	const fileDir = posix.dirname(repoRelPath);
	const out: string[] = [];
	TS_JS_IMPORT_RE.lastIndex = 0;
	let m: RegExpExecArray | null = TS_JS_IMPORT_RE.exec(content);
	while (m !== null) {
		const specifier = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
		if (specifier !== undefined) {
			const resolved = resolveTsJsSpecifier(repoRelPath, fileDir, specifier, deps);
			if (resolved !== null) out.push(resolved);
		}
		m = TS_JS_IMPORT_RE.exec(content);
	}
	return out;
}

// ============================================================================
// Python
// ============================================================================

/** `import a.b.c` / `import a, b.c as x` — captures the rest of the line. */
const PY_IMPORT_RE = /^[ \t]*import\s+(.+)$/gm;
/** `from <dots><dotted>? import ...` — dots (group 1) + dotted module (group 2, optional). */
const PY_FROM_RE = /^[ \t]*from\s+(\.*)([\w][\w.]*)?\s+import\b/gm;

/** Strip a trailing `as alias` and surrounding whitespace from one import token. */
function stripPyAlias(token: string): string {
	const asIdx = token.search(/\bas\b/);
	return (asIdx >= 0 ? token.slice(0, asIdx) : token).trim();
}

/** `a.b.c` (relative to `baseDir`) -> [`baseDir/a/b/c.py`, `baseDir/a/b/c/__init__.py`]. */
function pyModuleCandidates(baseDir: string, dottedPath: string): string[] {
	const segments = dottedPath.split(".").filter((s) => s.length > 0);
	if (segments.length === 0) return [posix.join(baseDir, "__init__.py")];
	const dirPath = posix.join(baseDir, ...segments);
	return [`${dirPath}.py`, posix.join(dirPath, "__init__.py")];
}

function resolvePyCandidates(candidates: string[], fileExists: (p: string) => boolean): string | null {
	for (const c of candidates) {
		if (fileExists(c)) return c;
	}
	return null;
}

/**
 * Relative-import base dir for `dotCount` leading dots: 1 dot = the current
 * file's own package (its containing dir); each extra dot walks one dir up.
 */
function pyRelativeBaseDir(fileDir: string, dotCount: number): string {
	let dir = fileDir;
	for (let i = 1; i < dotCount; i++) dir = posix.dirname(dir);
	return dir;
}

export function extractPythonDeps(content: string, repoRelPath: string, deps: EdgeResolveDeps): string[] {
	const fileDir = posix.dirname(repoRelPath);
	const out: string[] = [];

	PY_IMPORT_RE.lastIndex = 0;
	for (let m = PY_IMPORT_RE.exec(content); m !== null; m = PY_IMPORT_RE.exec(content)) {
		// Absolute `import` statements are always root-relative in Python 3 — never
		// leading-dot relative (only `from` supports that).
		const rest = (m[1] ?? "").split("#")[0] ?? ""; // drop a trailing inline comment
		for (const rawToken of rest.split(",")) {
			const dotted = stripPyAlias(rawToken);
			if (dotted.length === 0 || !/^[\w][\w.]*$/.test(dotted)) continue;
			const resolved = resolvePyCandidates(pyModuleCandidates("", dotted), deps.fileExists);
			if (resolved) out.push(resolved);
		}
	}

	PY_FROM_RE.lastIndex = 0;
	for (let m = PY_FROM_RE.exec(content); m !== null; m = PY_FROM_RE.exec(content)) {
		const dots = m[1] ?? "";
		const dotted = m[2] ?? "";
		const baseDir = dots.length > 0 ? pyRelativeBaseDir(fileDir, dots.length) : "";
		const resolved = resolvePyCandidates(pyModuleCandidates(baseDir, dotted), deps.fileExists);
		if (resolved) out.push(resolved);
	}

	return out;
}

// ============================================================================
// Rust
// ============================================================================

/** `mod name;` (visibility-qualified) — inline `mod name { ... }` bodies don't match (no trailing `;`). */
const RS_MOD_RE = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_][\w]*)\s*;/gm;
/** Every `use <path>;` statement, brace lists and newlines included (non-greedy up to the first `;`). */
const RS_USE_RE = /\buse\s+([\s\S]*?);/g;

/** File names that themselves stand for their containing directory's module. */
const RUST_MODULE_FILES = new Set(["mod.rs", "lib.rs", "main.rs"]);

function rustModuleFile(dir: string, fileExists: (p: string) => boolean): string | null {
	const rsPath = `${dir}.rs`;
	if (fileExists(rsPath)) return rsPath;
	const modPath = posix.join(dir, "mod.rs");
	if (fileExists(modPath)) return modPath;
	return null;
}

/** Nearest ancestor directory literally named `src`, walking UP from `fileDir`. */
function findCrateSrcRoot(fileDir: string): string | null {
	const segments = fileDir.split("/").filter((s) => s.length > 0);
	for (let i = segments.length - 1; i >= 0; i--) {
		if (segments[i] === "src") return segments.slice(0, i + 1).join("/");
	}
	return null;
}

/** Directory `self::` resolves against: the dir itself for mod.rs/lib.rs/main.rs, else `<dir>/<stem>`. */
function rustSelfDir(fileDir: string, fileName: string): string {
	if (RUST_MODULE_FILES.has(fileName)) return fileDir;
	return posix.join(fileDir, fileName.slice(0, -3)); // strip ".rs"
}

/** Directory `super::` (repeated `count` times) resolves against. */
function rustSuperDir(fileDir: string, fileName: string, count: number): string {
	let base = RUST_MODULE_FILES.has(fileName) ? posix.dirname(fileDir) : fileDir;
	for (let i = 1; i < count; i++) base = posix.dirname(base);
	return base;
}

/** Drop a trailing `::{...}` item list or `::*` glob so what remains is a pure module path. */
function stripBraceAndGlob(s: string): string {
	const braceIdx = s.indexOf("{");
	let out = braceIdx >= 0 ? s.slice(0, braceIdx) : s;
	if (out.endsWith("*")) out = out.slice(0, -1);
	if (out.endsWith("::")) out = out.slice(0, -2);
	return out;
}

/**
 * Best-effort `use` path resolution: the LAST segment is ambiguous (it may be a
 * submodule OR an item defined inside the parent module — `use crate::a::Foo;`
 * can't be told apart from `use crate::a::b;` by regex alone), so try the full
 * segment list as a module path first, then fall back to dropping the last
 * segment (treating it as an item name) and resolving the shorter prefix.
 */
function resolveRustSegments(
	base: string | null,
	segments: string[],
	fileExists: (p: string) => boolean,
): string | null {
	if (base === null || segments.length === 0) return null;
	const full = rustModuleFile(posix.join(base, ...segments), fileExists);
	if (full) return full;
	if (segments.length > 1) return rustModuleFile(posix.join(base, ...segments.slice(0, -1)), fileExists);
	return null;
}

export function extractRustDeps(content: string, repoRelPath: string, deps: EdgeResolveDeps): string[] {
	const fileDir = posix.dirname(repoRelPath);
	const fileName = posix.basename(repoRelPath);
	const out: string[] = [];

	RS_MOD_RE.lastIndex = 0;
	for (let m = RS_MOD_RE.exec(content); m !== null; m = RS_MOD_RE.exec(content)) {
		const name = m[1];
		if (!name) continue;
		const resolved = rustModuleFile(posix.join(fileDir, name), deps.fileExists);
		if (resolved) out.push(resolved);
	}

	RS_USE_RE.lastIndex = 0;
	for (let m = RS_USE_RE.exec(content); m !== null; m = RS_USE_RE.exec(content)) {
		// Strip `as alias` BEFORE collapsing whitespace (needs the word boundaries),
		// then collapse remaining whitespace/newlines (brace lists may span lines).
		const rawStatement = (m[1] ?? "").replace(/\s+as\s+[\w]+/g, "").replace(/\s+/g, "");
		if (rawStatement.length === 0) continue;

		let base: string | null;
		let rest = rawStatement;
		if (rest === "crate" || rest.startsWith("crate::")) {
			base = findCrateSrcRoot(fileDir);
			rest = rest === "crate" ? "" : rest.slice(7);
		} else {
			let superCount = 0;
			while (rest === "super" || rest.startsWith("super::")) {
				superCount++;
				rest = rest === "super" ? "" : rest.slice(7);
			}
			if (superCount > 0) {
				base = rustSuperDir(fileDir, fileName, superCount);
			} else if (rest === "self" || rest.startsWith("self::")) {
				base = rustSelfDir(fileDir, fileName);
				rest = rest === "self" ? "" : rest.slice(6);
			} else {
				continue; // external crate (or an unmodeled form) — discarded
			}
		}

		const pathPart = stripBraceAndGlob(rest);
		const segments = pathPart.length > 0 ? pathPart.split("::").filter((s) => s.length > 0) : [];
		const resolved = resolveRustSegments(base, segments, deps.fileExists);
		if (resolved) out.push(resolved);
	}

	return out;
}
