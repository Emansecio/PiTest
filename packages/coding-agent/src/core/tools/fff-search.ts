import { Minimatch } from "minimatch";
import path from "path";

/**
 * Optional `fff` (Fast File Finder) backend for the grep and find tools.
 *
 * `fff` keeps a warm, in-memory index of the repository and answers searches
 * from native Rust without spawning a process per query — measured at 18-27x
 * faster than a per-query `rg` spawn on this repo (the spawn startup, not the
 * scan, is the cost `fff` removes). The grep tool always falls back to ripgrep
 * when this module is unavailable or a query is outside fff's supported subset.
 *
 * Lazy-loaded via `await import()` (the package is ESM-only — its `exports`
 * field exposes no `require` entry — so `createRequire` cannot reach it) and
 * cached. A platform without the prebuilt native binary degrades to `rg`
 * instead of crashing: any load failure marks the backend unavailable.
 *
 * Supported here (all validated for PARITY against `rg` on the real repo):
 * - `content`, `files` (files_with_matches), and `count` output modes.
 * - whole-repo OR a subdirectory / single file (via a client-side path-prefix
 *   filter — fff's single-grep has no path constraint, and multiGrep's
 *   `constraints` did NOT scope by subdir in testing, so we filter results).
 *
 * Parity invariants baked in:
 * - `smartCase: false` always — `rg`'s default is case-sensitive, while fff's
 *   `smartCase` default would treat an all-lowercase query as case-INSENSITIVE.
 *   Case-insensitive queries use inline `(?i)` regex when routed through fff.
 * - Both silent caps are defeated by paginating with the cursor: fff's defaults
 *   (`pageSize` 50, `maxMatchesPerFile` 200) would under-report (58 of 796 for
 *   "AgentSession"); we page until the caller's limit is met or the result set
 *   is exhausted, deduping by cursor (validated: 720/720, 0 dups).
 * - A regex fff cannot compile (`regexFallbackError`) returns null so the tool
 *   falls back to `rg`, surfacing the real parse error instead of fff's silent
 *   literal fallback.
 * - If a subdir scan can't be PROVEN complete within the page budget, we return
 *   null (fallback rg) rather than emit a silently-truncated subdir result.
 */

// ---- Minimal structural types for the optional package (avoid a hard type
// dependency so tsgo/builds succeed on machines where the dep is absent). ----
interface FffResult<T> {
	ok: boolean;
	value?: T;
	error?: string;
}
interface FffGrepMatch {
	relativePath: string;
	lineNumber: number;
	col: number;
	lineContent: string;
}
interface FffGrepResult {
	items: FffGrepMatch[];
	nextCursor: unknown | null;
	regexFallbackError?: string;
}
interface FffGrepOptions {
	mode?: "plain" | "regex" | "fuzzy";
	smartCase?: boolean;
	pageSize?: number;
	maxMatchesPerFile?: number;
	beforeContext?: number;
	afterContext?: number;
	cursor?: unknown | null;
}
interface FffGlobItem {
	relativePath: string;
}
interface FffGlobResult {
	items: FffGlobItem[];
	totalMatched: number;
}
interface FffGlobOptions {
	pageIndex?: number;
	pageSize?: number;
}
interface FffFinder {
	waitForScan: (timeoutMs: number) => Promise<unknown>;
	grep: (pattern: string, options?: FffGrepOptions) => FffResult<FffGrepResult>;
	glob: (pattern: string, options?: FffGlobOptions) => FffResult<FffGlobResult>;
	destroy: () => void;
}
interface FffModule {
	FileFinder: { create: (init: { basePath: string }) => FffResult<FffFinder> };
}

/** A single content match in the same shape the grep tool's rg path collects. */
export interface FffContentMatch {
	/** Absolute file path (rejoined from fff's repo-relative path). */
	filePath: string;
	/** 1-based line number. */
	lineNumber: number;
	/** The matched line text. */
	lineText: string;
	/** 0-based BYTE column of the first match start (grep.ts converts to char index). */
	col: number;
}

export type FffSearchMode = "content" | "files" | "count";

export interface FffSearchArgs {
	basePath: string;
	pattern: string;
	mode: FffSearchMode;
	/** Treat pattern as a literal string (maps to fff "plain" mode). */
	literal?: boolean;
	/** Context lines before/after each match (symmetric, like grep's `context`). Content mode only. */
	context?: number;
	/** Max matches (content) or files (files/count) to return. */
	limit: number;
	/**
	 * Repo-relative POSIX path to scope the search to. Empty/undefined = whole
	 * repo. A directory prefix matches `${subPrefix}/...`; set `subExact` to match
	 * a single file path exactly.
	 */
	subPrefix?: string;
	subExact?: boolean;
	/** Case-insensitive search (regex `(?i)` prefix). */
	ignoreCase?: boolean;
	/** Simple single glob; client-side filter on repo-relative paths. */
	globFilter?: string;
}

export interface FffFindByGlobArgs {
	basePath: string;
	pattern: string;
	/** Repo-relative POSIX directory prefix to scope results. */
	subPrefix?: string;
	limit: number;
}

/**
 * Find files by glob through the warm fff index (`finder.glob`). Returns null on
 * failure, scan timeout, or unprovable scoped completeness.
 */
export async function fffFindByGlob(args: FffFindByGlobArgs): Promise<string[] | null> {
	const mod = await loadModule();
	if (!mod) return null;
	try {
		const entry = getFinder(mod, args.basePath);
		if (!entry) return null;
		const scanned = await entry.ready;
		if (!scanned) return null;

		const inScope = makeScopeFilter(args.subPrefix);
		const scoped = Boolean(args.subPrefix);
		const paths: string[] = [];
		let pageIndex = 0;
		let exhausted = false;

		for (let page = 0; page < MAX_PAGES; page++) {
			const res = entry.finder.glob(args.pattern, { pageIndex, pageSize: PAGE_SIZE });
			if (!res.ok || !res.value) return null;

			for (const item of res.value.items) {
				const rel = toPosix(item.relativePath);
				if (isGitInternalPath(rel)) continue;
				if (!inScope(rel)) continue;
				paths.push(rel);
				if (paths.length >= args.limit) break;
			}

			if (paths.length >= args.limit) break;
			const fetched = (pageIndex + 1) * PAGE_SIZE;
			if (res.value.items.length === 0 || fetched >= res.value.totalMatched) {
				exhausted = true;
				break;
			}
			pageIndex += 1;
		}

		if (scoped && !exhausted && paths.length < args.limit) return null;
		return paths;
	} catch {
		return null;
	}
}

export type FffSearchResult =
	| { mode: "content"; matches: FffContentMatch[]; capped: boolean }
	| { mode: "files"; files: string[]; capped: boolean }
	| { mode: "count"; counts: Array<{ filePath: string; count: number }>; capped: boolean };

const SCAN_TIMEOUT_MS = 30_000;
/** Bound the number of live finders (each holds an index + FS watcher). A TUI
 * session has a single fixed cwd, so 1 is typical; the cap only matters for
 * tests / multi-root callers. The least-recently-used finder is destroyed. */
const MAX_FINDERS = 4;
/** Matches fetched per cursor page. */
const PAGE_SIZE = 1000;
/** Page budget for a single search. A sparse subdir filter could otherwise walk
 * the whole repo; when this is hit without proving completeness we fall back to
 * rg (which scopes natively) instead of returning a truncated subdir result. */
const MAX_PAGES = 50;
/** Per-file cap high enough never to clip a file's matches below a page. */
const BIG_PER_FILE = 1_000_000;

let moduleState: { mod: FffModule } | "unavailable" | "unloaded" = "unloaded";
let loadPromise: Promise<FffModule | null> | null = null;

function loadModule(): Promise<FffModule | null> {
	if (moduleState === "unavailable") return Promise.resolve(null);
	if (moduleState !== "unloaded") return Promise.resolve(moduleState.mod);
	if (!loadPromise) {
		loadPromise = (async () => {
			try {
				const mod = (await import("@ff-labs/fff-node")) as unknown as FffModule;
				if (!mod || typeof mod.FileFinder?.create !== "function") {
					moduleState = "unavailable";
					return null;
				}
				moduleState = { mod };
				return mod;
			} catch {
				// Package or native binary absent for this platform → degrade to rg.
				moduleState = "unavailable";
				return null;
			}
		})();
	}
	return loadPromise;
}

/** Whether the fff native backend can be loaded at all on this machine. */
export async function isFffAvailable(): Promise<boolean> {
	return (await loadModule()) !== null;
}

/** Start indexing `basePath` in the background; never throws. */
export function prewarmFffIndex(basePath: string): void {
	void loadModule()
		.then((mod) => {
			if (mod) getFinder(mod, basePath);
		})
		.catch(() => {
			// fail-open
		});
}

/** True when `glob` is safe to emulate client-side (single simple pattern). */
export function isSimpleGrepGlob(glob: string | undefined): glob is string {
	if (!glob) return false;
	if (glob.startsWith("!")) return false;
	if (glob.includes(",") || glob.includes("{") || glob.includes("}")) return false;
	return true;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isGitInternalPath(relPosix: string): boolean {
	return relPosix === ".git" || relPosix.startsWith(".git/") || relPosix.includes("/.git/");
}

function resolveFffGrepPattern(
	pattern: string,
	literal: boolean | undefined,
	ignoreCase: boolean | undefined,
): {
	pattern: string;
	mode: "plain" | "regex";
} {
	if (!ignoreCase) {
		return { pattern, mode: literal ? "plain" : "regex" };
	}
	if (literal) {
		return { pattern: `(?i)${escapeRegExp(pattern)}`, mode: "regex" };
	}
	return { pattern: `(?i)${pattern}`, mode: "regex" };
}

function makeGlobPathFilter(globFilter: string): (relPosix: string) => boolean {
	const matcher = new Minimatch(globFilter, { dot: false });
	return (relPosix: string) => {
		if (matcher.match(relPosix)) return true;
		const base = path.posix.basename(relPosix);
		return matcher.match(base);
	};
}

// basePath -> warm finder (lazily created, scanned once, reused across queries).
interface FinderEntry {
	finder: FffFinder;
	ready: Promise<boolean>;
	lastUsed: number;
}
const finders = new Map<string, FinderEntry>();
let useClock = 0;
let exitHookInstalled = false;

function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	const cleanup = (): void => {
		for (const entry of finders.values()) {
			try {
				entry.finder.destroy();
			} catch {
				// best-effort
			}
		}
		finders.clear();
	};
	process.once("exit", cleanup);
}

function evictIfNeeded(): void {
	while (finders.size > MAX_FINDERS) {
		let oldestKey: string | undefined;
		let oldest = Infinity;
		for (const [key, entry] of finders) {
			if (entry.lastUsed < oldest) {
				oldest = entry.lastUsed;
				oldestKey = key;
			}
		}
		if (oldestKey === undefined) return;
		const victim = finders.get(oldestKey);
		finders.delete(oldestKey);
		try {
			victim?.finder.destroy();
		} catch {
			// best-effort
		}
	}
}

function getFinder(mod: FffModule, basePath: string): FinderEntry | null {
	const existing = finders.get(basePath);
	if (existing) {
		existing.lastUsed = ++useClock;
		return existing;
	}
	const created = mod.FileFinder.create({ basePath });
	if (!created.ok || !created.value) return null;
	const finder = created.value;
	const ready = finder
		.waitForScan(SCAN_TIMEOUT_MS)
		.then(() => true)
		.catch(() => false);
	const entry: FinderEntry = { finder, ready, lastUsed: ++useClock };
	finders.set(basePath, entry);
	installExitHook();
	evictIfNeeded();
	return entry;
}

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/** Build the path-prefix predicate for the optional subdir/file scope. */
function makeScopeFilter(subPrefix?: string, subExact?: boolean): (relPosix: string) => boolean {
	if (!subPrefix) return () => true;
	if (subExact) return (rel) => rel === subPrefix;
	const dir = `${subPrefix}/`;
	return (rel) => rel.startsWith(dir);
}

/**
 * Run a search through the warm fff index. Returns null on ANY failure or
 * unsupported condition so the caller transparently falls back to ripgrep —
 * this backend never throws.
 */
export async function fffSearch(args: FffSearchArgs): Promise<FffSearchResult | null> {
	const mod = await loadModule();
	if (!mod) return null;
	try {
		const entry = getFinder(mod, args.basePath);
		if (!entry) return null;
		const scanned = await entry.ready;
		// Scan timed out / failed → fall back to ripgrep transparently.
		if (!scanned) return null;

		const inScope = makeScopeFilter(args.subPrefix, args.subExact);
		const scoped = Boolean(args.subPrefix) || Boolean(args.globFilter);
		const matchesGlob = args.globFilter ? makeGlobPathFilter(args.globFilter) : () => true;
		const ctx = args.context && args.context > 0 ? args.context : 0;
		// files mode wants one row per file; content/count want every match line.
		const perFile = args.mode === "files" ? 1 : BIG_PER_FILE;
		const grepPattern = resolveFffGrepPattern(args.pattern, args.literal, args.ignoreCase);

		const contentMatches: FffContentMatch[] = [];
		const fileOrder: string[] = [];
		const seenFiles = new Set<string>();
		const counts = new Map<string, number>();

		let cursor: unknown | null = null;
		let capped = false;
		let exhausted = false;
		for (let page = 0; page < MAX_PAGES; page++) {
			const res = entry.finder.grep(grepPattern.pattern, {
				mode: grepPattern.mode,
				smartCase: false,
				pageSize: PAGE_SIZE,
				maxMatchesPerFile: perFile,
				beforeContext: ctx,
				afterContext: ctx,
				cursor,
			});
			if (!res.ok || !res.value) return null;
			// fff silently falls back to literal when a regex won't compile; defer to
			// rg so the user gets the real parse error instead of wrong-but-quiet hits.
			if (res.value.regexFallbackError) return null;

			for (const it of res.value.items) {
				if (typeof it.lineNumber !== "number") continue;
				const rel = toPosix(it.relativePath);
				if (!inScope(rel)) continue;
				if (!matchesGlob(rel)) continue;
				const abs = path.resolve(args.basePath, it.relativePath);
				if (args.mode === "content") {
					contentMatches.push({
						filePath: abs,
						lineNumber: it.lineNumber,
						lineText: it.lineContent ?? "",
						col: typeof it.col === "number" ? it.col : 0,
					});
					if (contentMatches.length >= args.limit) {
						capped = true;
						break;
					}
				} else if (args.mode === "files") {
					if (!seenFiles.has(abs)) {
						seenFiles.add(abs);
						fileOrder.push(abs);
						if (fileOrder.length >= args.limit) {
							capped = true;
							break;
						}
					}
				} else {
					counts.set(abs, (counts.get(abs) ?? 0) + 1);
				}
			}

			if (capped) break;
			if (res.value.nextCursor == null) {
				exhausted = true;
				break;
			}
			cursor = res.value.nextCursor;
		}

		// A scoped (subdir) search that neither hit the limit nor exhausted the
		// index within the page budget can't be proven complete → fall back to rg
		// (which scopes natively) rather than emit a truncated subdir result.
		if (scoped && !capped && !exhausted) return null;

		if (args.mode === "content") return { mode: "content", matches: contentMatches, capped };
		if (args.mode === "files") return { mode: "files", files: fileOrder, capped };
		// count: limit caps the number of files reported (mirrors rg --count + limit).
		const entries = [...counts.entries()];
		const countCapped = entries.length > args.limit;
		const sliced = countCapped ? entries.slice(0, args.limit) : entries;
		return {
			mode: "count",
			counts: sliced.map(([filePath, count]) => ({ filePath, count })),
			capped: countCapped,
		};
	} catch {
		return null;
	}
}
