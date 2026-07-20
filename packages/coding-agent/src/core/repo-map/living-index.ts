/**
 * Living Repo Map — git-anchored, INCREMENTAL symbol index.
 *
 * The compaction file-digests want a current per-file symbol outline. Building
 * that from scratch every time means re-reading + re-parsing every touched file
 * on every compaction. This module amortizes that: it keeps a persisted cache
 * (`.pit/repo-map.jsonl`) of {path -> symbols} anchored to the last indexed
 * commit, and on each call re-indexes ONLY the files that changed since that
 * commit (via `git diff --name-status`). Unchanged files keep their cached
 * symbols at zero parse cost — a strict reduction vs the always-rebuild digest.
 *
 * Anchoring uses `lastIndexedCommit` + per-file mtime (NOT blob-hash): mtime is
 * a single `stat` per touched file vs hashing whole bodies, and it also catches
 * UNCOMMITTED working-tree edits that a commit-only anchor would miss.
 *
 * Fail-safe by construction:
 *  - Not a git repo / git unavailable / git times out  → full `scanSourceFiles`
 *    walk, no commit persisted (cache still written with commit="" so a later
 *    git-enabled run rebuilds cleanly).
 *  - Corrupt / unreadable cache  → treated as empty, full reindex.
 *  - PIT_NO_LIVING_REPO_MAP truthy  → bail to a one-shot full scan with no
 *    persistence (escape hatch; the feature is ON by default).
 *  - PIT_NO_REPO_GRAPH truthy  → import-edge extraction (`deps`) is skipped
 *    entirely; symbols/decls indexing is UNAFFECTED (escape hatch for the edge
 *    layer only; see `edges.ts`/`graph.ts`).
 *
 * Pure-ish: all I/O (git, fs, scan, parse, clock) is injectable via `deps` so
 * tests drive exact scenarios without a real repo. Default deps wire the real
 * subprocess/fs.
 */

import { execFile } from "node:child_process";
import {
	closeSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { scanSourceFiles } from "../tools/source-scan.ts";
import { listDeclarations, listTopLevelDeclarations } from "../tools/symbol.ts";
import { extractFileDeps } from "./edges.ts";

/**
 * Bump when the on-disk schema changes incompatibly. v2 adds the optional
 * per-symbol `decls` (kind+line) projection consumed by the Band P context
 * composer. v3 adds the optional per-file `deps` (resolved import edges)
 * projection that turns the map into a graph (see `edges.ts`/`graph.ts`);
 * bumping invalidates v2 caches so they reindex cleanly with edges instead of
 * being read back without `deps`.
 */
export const CACHE_VERSION = 3 as const;

/** Wall-clock cap on the `git diff` subprocess; deep histories must not stall. */
const GIT_TIMEOUT_MS = 5000;

/** Wall-clock cap on `git rev-parse HEAD`. */
const HEAD_TIMEOUT_MS = 3000;

/**
 * Skip the symbol parse above this size (mirrors file-digests MAX_DIGEST_BYTES):
 * a re-indexed lockfile / bundle would otherwise be fully parsed for an outline
 * no one wants. Bounds the worst case of a single changed huge file.
 */
const MAX_INDEX_BYTES = 256 * 1024;

/** Symbols kept per file — matches the file-digests cap so the map feeds it 1:1. */
const MAX_SYMBOLS_PER_FILE = 12;

/** Dep edges kept per file — a hub file (barrel, index) shouldn't blow up the entry. */
const MAX_DEPS_PER_FILE = 64;

/** One top-level declaration: name + kind keyword + 1-based line. */
export interface RepoMapDecl {
	name: string;
	/** Declaration kind keyword (function/class/interface/const/def/…). */
	kind: string;
	/** 1-based line of the declaration. */
	line: number;
}

/** One indexed file: relative path + its symbol names + the mtime we indexed at. */
export interface RepoMapEntry {
	/** cwd-relative, forward-slash-normalized path (stable across OSes). */
	path: string;
	/** Symbol names (capped), in declaration order. */
	symbols: string[];
	/**
	 * Enriched projection (kind+line) of the same top-level declarations as
	 * `symbols`, capped identically. Optional so a v1 cache / a deps harness that
	 * omits `extractDeclarations` still round-trips; consumers (context composer)
	 * fall back to `symbols` when absent. NOT flattened into the grounding name
	 * pool — `repoMapToSymbolSet` reads `symbols` only.
	 */
	decls?: RepoMapDecl[];
	/**
	 * Resolved import edges: repo-relative, forward-slash paths of files THIS file
	 * imports (deduplicated, sorted, capped at `MAX_DEPS_PER_FILE`). Optional for
	 * the same reason `decls` is: a v2 cache / a deps harness that omits
	 * `extractDeps` round-trips as name+symbols-only, and PIT_NO_REPO_GRAPH leaves
	 * it unset by design. Powers `graph.ts` (buildRepoGraph/blastRadius) — absent
	 * on an entry simply means that file contributes no edges to the graph.
	 */
	deps?: string[];
	/** Epoch ms of the file mtime when these symbols were extracted. 0 if unknown. */
	mtimeMs: number;
}

/** The persisted cache: a commit anchor + the full symbol map. */
export interface LivingRepoMap {
	version: typeof CACHE_VERSION;
	/** Commit the cache is anchored to ("" when built from a non-git scan). */
	lastIndexedCommit: string;
	/** Indexed entries, keyed by `path` (kept as an array for JSONL streaming). */
	entries: RepoMapEntry[];
}

/** Result of `getLivingRepoMap`: the map plus how it was produced (for callers/tests). */
export interface LivingRepoMapResult {
	map: LivingRepoMap;
	/** "incremental" = git-delta reindex; "full-scan" = non-git or no anchor; "cache-hit" = nothing changed. */
	mode: "incremental" | "full-scan" | "cache-hit";
	/** Count of files that were (re)parsed this run — 0 on a pure cache hit. */
	reindexedCount: number;
}

/** A single line from `git diff --name-status`: status char + path(s). */
interface DiffEntry {
	status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X" | "B";
	path: string;
	/** Rename/copy destination (status R/C carries old\tnew). */
	renameTo?: string;
}

/**
 * Injectable I/O surface. Every field has a real default; tests override the
 * subset they exercise. Keeping this explicit (vs reaching for globals) is what
 * lets the test assert "listDeclarations called exactly once".
 */
export interface LivingRepoMapDeps {
	/** Resolve HEAD commit sha, or null if not a git repo / git failed. */
	resolveHead: (cwd: string) => Promise<string | null>;
	/** `git diff --name-status <base>..HEAD`, or null on failure / non-git. */
	gitDiff: (cwd: string, base: string) => Promise<DiffEntry[] | null>;
	/** Read a file's text, or null if unreadable / over cap. */
	readFile: (absPath: string) => string | null;
	/** Stat mtime in epoch ms, or 0 if the file is gone / unreadable. */
	statMtime: (absPath: string) => number;
	/** Full source-file walk (non-git fallback & cold start with no commit). */
	scan: (cwd: string) => Promise<string[]>;
	/** Extract declaration names from file content. */
	extractSymbols: (content: string, path: string) => string[];
	/**
	 * OPTIONAL enriched extractor: the same top-level declarations as
	 * `extractSymbols` but carrying kind+line. When present, each indexed entry
	 * gains a `decls` projection; when absent (e.g. a test harness that only
	 * stubs `extractSymbols`), entries stay name-only and consumers degrade
	 * gracefully. The default wires `listTopLevelDeclarations` (repo_map's extractor).
	 */
	extractDeclarations?: (content: string, path: string) => RepoMapDecl[];
	/**
	 * OPTIONAL edge extractor: resolves this file's import/require/use/mod
	 * specifiers to repo-relative dep paths (see `edges.ts`). `path` here is the
	 * REPO-RELATIVE key (unlike `extractSymbols`/`extractDeclarations`, which get
	 * the absolute path — edge resolution needs repo-relative math to produce
	 * repo-relative output). `fileExists` is a cheap, memoized-per-reindex-pass
	 * checker (see `makeFileExistsChecker`) so resolving N files importing the
	 * same shared module doesn't re-stat it N times. Absent (a deps harness that
	 * only stubs `extractSymbols`) -> entries carry no `deps`, same graceful
	 * degradation as `extractDeclarations`. Ignored entirely when
	 * PIT_NO_REPO_GRAPH is truthy (never called).
	 */
	extractDeps?: (content: string, path: string, fileExists: (repoRelPath: string) => boolean) => string[];
	/** Load the persisted cache, or undefined on any failure. */
	loadCache: (cachepath: string) => LivingRepoMap | undefined;
	/** Persist the cache atomically. Throws are swallowed by the caller. */
	saveCache: (cachePath: string, map: LivingRepoMap) => void;
	/** Path of the cache file for a given cwd. */
	cachePath: (cwd: string) => string;
}

/** Normalize a path to cwd-relative with forward slashes (cross-OS-stable keys). */
function toRelKey(cwd: string, p: string): string {
	const abs = isAbsolute(p) ? p : join(cwd, p);
	return relative(cwd, abs).split("\\").join("/");
}

/** Default cache location: `<cwd>/.pit/repo-map.jsonl`. */
export function defaultRepoMapCachePath(cwd: string): string {
	return join(cwd, ".pit", "repo-map.jsonl");
}

// --- Real-I/O default deps ---------------------------------------------------

/**
 * Run a git subprocess and resolve its stdout. Mirrors `runGitLog` in
 * frequent-files.ts: settle ONLY from inside execFile's callback so the child
 * has fully exited before we return — otherwise on Windows the cwd stays locked
 * just long enough to EBUSY a follow-up rmSync (and to corrupt the temp dir in
 * tests). On non-repo / error / timeout we resolve null and let the caller fall
 * back to a full scan.
 */
function runGit(cwd: string, args: string[], timeoutMs: number): Promise<string | null> {
	return new Promise<string | null>((resolve) => {
		let timedOut = false;
		const child = execFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
			clearTimeout(timer);
			if (timedOut || error) {
				resolve(null);
				return;
			}
			resolve(stdout);
		});
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
	});
}

async function defaultResolveHead(cwd: string): Promise<string | null> {
	const out = await runGit(cwd, ["rev-parse", "HEAD"], HEAD_TIMEOUT_MS);
	if (out === null) return null;
	const sha = out.trim();
	return sha.length > 0 ? sha : null;
}

/** Parse one `--name-status` line into a DiffEntry (handles R###/C### rename pairs). */
function parseDiffLine(line: string): DiffEntry | null {
	const trimmed = line.replace(/\r$/, "");
	if (trimmed.length === 0) return null;
	const parts = trimmed.split("\t");
	const rawStatus = parts[0] ?? "";
	const code = rawStatus[0] ?? "";
	// Rename/copy carry "R100\told\tnew" — index by destination, drop the source.
	if ((code === "R" || code === "C") && parts.length >= 3) {
		return { status: code, path: parts[1]!, renameTo: parts[2]! };
	}
	if (parts.length >= 2) {
		const valid = "AMDRCTUXB";
		const status = valid.includes(code) ? code : "M";
		return { status: status as DiffEntry["status"], path: parts[1]! };
	}
	return null;
}

async function defaultGitDiff(cwd: string, base: string): Promise<DiffEntry[] | null> {
	// `<base>..HEAD` is the committed delta; uncommitted edits are caught
	// separately by the mtime check, so we don't need --diff-filter here.
	const out = await runGit(cwd, ["diff", "--name-status", `${base}..HEAD`], GIT_TIMEOUT_MS);
	if (out === null) return null;
	const entries: DiffEntry[] = [];
	for (const line of out.split("\n")) {
		const parsed = parseDiffLine(line);
		if (parsed) entries.push(parsed);
	}
	return entries;
}

function defaultReadFile(absPath: string): string | null {
	try {
		const content = readFileSync(absPath, "utf8");
		if (content.length > MAX_INDEX_BYTES) return null;
		return content;
	} catch {
		return null;
	}
}

function defaultStatMtime(absPath: string): number {
	try {
		return statSync(absPath).mtimeMs;
	} catch {
		return 0;
	}
}

function defaultExtractSymbols(content: string, path: string): string[] {
	const decls = listDeclarations(content, path);
	// Keep bare names: `repoMapToSymbolSet` flattens these into the grounding-guard
	// name pool, which must match identifiers verbatim (kind/line would break it).
	const names = decls.slice(0, MAX_SYMBOLS_PER_FILE).map((d) => d.name);
	// Mark truncation so a consumer (digest / repo map) sees the outline is partial.
	if (decls.length > MAX_SYMBOLS_PER_FILE) names.push(`(+${decls.length - MAX_SYMBOLS_PER_FILE} more)`);
	return names;
}

/**
 * Enriched extractor: reuse repo_map's `listTopLevelDeclarations` (kind+name+line,
 * no block-end walk) and cap to the same budget as the name list so the two
 * projections stay 1:1. No truncation sentinel here — `decls` is structured data,
 * not a rendered outline.
 */
function defaultExtractDeclarations(content: string, path: string): RepoMapDecl[] {
	return listTopLevelDeclarations(content, path)
		.slice(0, MAX_SYMBOLS_PER_FILE)
		.map((d) => ({ name: d.name, kind: d.kind, line: d.line }));
}

/**
 * Default edge extractor: wires `edges.ts`'s pure extract+resolve, capped to
 * `MAX_DEPS_PER_FILE`. `extractFileDeps` already dedupes+sorts, so the cap keeps
 * the alphabetically-first edges on truncation (deterministic, not arbitrary).
 */
function defaultExtractDeps(content: string, repoRelPath: string, fileExists: (p: string) => boolean): string[] {
	return extractFileDeps(content, repoRelPath, { fileExists }).slice(0, MAX_DEPS_PER_FILE);
}

/**
 * Best-effort cache read. JSONL: line 0 is the header
 * `{version,lastIndexedCommit}`, each subsequent non-empty line is one
 * RepoMapEntry. A malformed line is skipped (advisory data, never load-bearing).
 */
/**
 * Validate + normalize a persisted `decls` array. Returns undefined when the
 * field is absent or malformed (v1 caches, corrupt lines) so the entry stays
 * name-only. Each element must carry a string name+kind and a finite line.
 */
function parseDecls(raw: unknown): RepoMapDecl[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: RepoMapDecl[] = [];
	for (const d of raw) {
		if (!d || typeof d !== "object") continue;
		const c = d as Partial<RepoMapDecl>;
		if (typeof c.name !== "string" || typeof c.kind !== "string") continue;
		const line = typeof c.line === "number" && Number.isFinite(c.line) ? c.line : 0;
		out.push({ name: c.name, kind: c.kind, line });
	}
	return out.length > 0 ? out : undefined;
}

/**
 * Validate + normalize a persisted `deps` array. Returns undefined when absent /
 * malformed (v2 caches never carried this field, corrupt lines) so the entry
 * round-trips without edges rather than throwing.
 */
function parseDeps(raw: unknown): string[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: string[] = [];
	for (const d of raw) {
		if (typeof d === "string") out.push(d);
	}
	return out.length > 0 ? out : undefined;
}

export function loadRepoMapCache(cachePath: string): LivingRepoMap | undefined {
	let raw: string;
	try {
		raw = readFileSync(cachePath, "utf8");
	} catch {
		return undefined;
	}
	const lines = raw.split("\n");
	if (lines.length === 0) return undefined;
	let header: unknown;
	try {
		header = JSON.parse(lines[0]!);
	} catch {
		return undefined;
	}
	if (!header || typeof header !== "object") return undefined;
	const h = header as { version?: unknown; lastIndexedCommit?: unknown };
	if (h.version !== CACHE_VERSION) return undefined;
	const lastIndexedCommit = typeof h.lastIndexedCommit === "string" ? h.lastIndexedCommit : "";
	const entries: RepoMapEntry[] = [];
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i]!.trim();
		if (line.length === 0) continue;
		try {
			const obj = JSON.parse(line) as Partial<RepoMapEntry>;
			if (typeof obj.path !== "string" || !Array.isArray(obj.symbols)) continue;
			const mtimeMs = typeof obj.mtimeMs === "number" && Number.isFinite(obj.mtimeMs) ? obj.mtimeMs : 0;
			const decls = parseDecls(obj.decls);
			const depsList = parseDeps(obj.deps);
			const entry: RepoMapEntry = { path: obj.path, symbols: obj.symbols.map(String), mtimeMs };
			if (decls) entry.decls = decls;
			if (depsList) entry.deps = depsList;
			entries.push(entry);
		} catch {
			// Skip the corrupt line; partial caches still accelerate the rest.
		}
	}
	return { version: CACHE_VERSION, lastIndexedCommit, entries };
}

/**
 * Atomic JSONL write: header line + one line per entry, to `<path>.tmp` then
 * rename. Mirrors `saveFrequentFilesSnapshot` (fsync + rename so a crash
 * mid-write leaves the prior cache intact). Creates parent dirs.
 */
export function saveRepoMapCache(cachePath: string, map: LivingRepoMap): void {
	mkdirSync(dirname(cachePath), { recursive: true });
	const header = JSON.stringify({ version: CACHE_VERSION, lastIndexedCommit: map.lastIndexedCommit });
	const body = map.entries.map((e) => JSON.stringify(e)).join("\n");
	const payload = body.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
	const tmpPath = `${cachePath}.tmp`;
	const fd = openSync(tmpPath, "w");
	try {
		writeSync(fd, payload);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	try {
		renameSync(tmpPath, cachePath);
	} catch (err) {
		try {
			unlinkSync(tmpPath);
		} catch {
			// best effort
		}
		throw err;
	}
}

export const defaultLivingRepoMapDeps: LivingRepoMapDeps = {
	resolveHead: defaultResolveHead,
	gitDiff: defaultGitDiff,
	readFile: defaultReadFile,
	statMtime: defaultStatMtime,
	scan: (cwd) => scanSourceFiles(cwd),
	extractSymbols: defaultExtractSymbols,
	extractDeclarations: defaultExtractDeclarations,
	extractDeps: defaultExtractDeps,
	loadCache: loadRepoMapCache,
	saveCache: saveRepoMapCache,
	cachePath: defaultRepoMapCachePath,
};

// --- Core flow ---------------------------------------------------------------

/**
 * Memoized existence check for edge resolution: caches lookups (via
 * `deps.statMtime`, the same injectable I/O the mtime-drift check below already
 * uses) for the duration of ONE reindex pass, so N files importing the same
 * shared module don't re-stat it N times. `knownPaths` (paths already known to
 * the map BEFORE this pass — cached entries, or this run's full scan list) are
 * seeded as free hits; anything else falls through to a real stat, which
 * correctly finds files created/reindexed earlier in THIS SAME pass too
 * (statMtime reflects live disk state, not a stale snapshot).
 */
function makeFileExistsChecker(
	cwd: string,
	deps: LivingRepoMapDeps,
	knownPaths: Iterable<string>,
): (repoRelPath: string) => boolean {
	const cache = new Map<string, boolean>();
	for (const p of knownPaths) cache.set(p, true);
	return (repoRelPath: string) => {
		const cached = cache.get(repoRelPath);
		if (cached !== undefined) return cached;
		const exists = deps.statMtime(join(cwd, repoRelPath)) !== 0;
		cache.set(repoRelPath, exists);
		return exists;
	};
}

/** Index one file (abs path) into an entry, or null if it has no symbols/unreadable. */
function indexFile(
	cwd: string,
	relPath: string,
	deps: LivingRepoMapDeps,
	fileExists: (repoRelPath: string) => boolean,
	extractDepsEnabled: boolean,
): RepoMapEntry | null {
	const abs = isAbsolute(relPath) ? relPath : join(cwd, relPath);
	// Capture mtime BEFORE reading content so a write racing between the two
	// makes the stored mtime strictly older than the file's real mtime, forcing
	// a reindex next run instead of pairing the new mtime with stale symbols.
	const mtimeMs = deps.statMtime(abs);
	const content = deps.readFile(abs);
	if (content === null) return null;
	const symbols = deps.extractSymbols(content, abs);
	if (symbols.length === 0) return null;
	const repoRelPath = toRelKey(cwd, relPath);
	const entry: RepoMapEntry = { path: repoRelPath, symbols, mtimeMs };
	// Enriched projection (kind+line) when the dep is wired. Best-effort: any
	// throw degrades to the name-only entry (never breaks indexing).
	if (deps.extractDeclarations) {
		try {
			const decls = deps.extractDeclarations(content, abs);
			if (decls.length > 0) entry.decls = decls;
		} catch {
			// name-only fallback
		}
	}
	// Edge extraction: skipped entirely under PIT_NO_REPO_GRAPH (extractDepsEnabled
	// false) — the entry simply has no `deps`, same as a v2-only harness. Best-effort:
	// any throw degrades to the deps-less entry (never breaks indexing).
	if (extractDepsEnabled && deps.extractDeps) {
		try {
			const fileDeps = deps.extractDeps(content, repoRelPath, fileExists);
			if (fileDeps.length > 0) entry.deps = fileDeps;
		} catch {
			// no-deps fallback
		}
	}
	return entry;
}

/** Build a fresh map from a full source-file walk (non-git / cold-start path). */
async function fullScan(
	cwd: string,
	commit: string,
	deps: LivingRepoMapDeps,
	extractDepsEnabled: boolean,
): Promise<LivingRepoMapResult> {
	const files = await deps.scan(cwd);
	// Every scanned file exists on disk by construction — seed the checker with
	// them so the common case (one scanned file importing another) never stats.
	const fileExists = makeFileExistsChecker(
		cwd,
		deps,
		files.map((f) => toRelKey(cwd, f)),
	);
	const entries: RepoMapEntry[] = [];
	for (const file of files) {
		const entry = indexFile(cwd, file, deps, fileExists, extractDepsEnabled);
		if (entry) entries.push(entry);
	}
	return {
		map: { version: CACHE_VERSION, lastIndexedCommit: commit, entries },
		mode: "full-scan",
		reindexedCount: entries.length,
	};
}

/**
 * Short-TTL process-level memo for `getLivingRepoMap`, keyed by `(cwd,
 * resolvedHead)`. Several independent callers (agent-session, grounding-guard,
 * impact, intent-gate extensions) each request the map within the same burst
 * of tool calls; without this, each one re-runs `resolveHead` + `loadCache` +
 * `gitDiff` + the re-stat loop from scratch. The TTL is short enough that it
 * never masks a genuine change between two calls that are seconds apart —
 * callers that need freshness beyond that already re-check mtime drift on the
 * entries they get back. Only used for the DEFAULT deps: tests inject their
 * own `deps` object to drive exact scenarios (parse counts, save counts, …),
 * and memoizing across those would silently skip the very I/O they assert on
 * — so any non-default `deps` bypasses the memo entirely.
 */
const LIVING_REPO_MAP_MEMO_TTL_MS = 1000;

interface LivingRepoMapMemoEntry {
	result: LivingRepoMapResult;
	expiresAt: number;
}

const livingRepoMapMemo = new Map<string, LivingRepoMapMemoEntry>();

function livingRepoMapMemoKey(cwd: string, head: string | null): string {
	// "::" can't appear in a git sha (plain hex), so it's a safe delimiter; the
	// non-git case gets its own "::null" tail so it can never collide with a
	// (never actually possible) empty-string sha.
	return `${cwd}::${head === null ? "::null" : head}`;
}

/** Test-only: clear the memo between cases so a stale entry can't leak across tests. */
export function clearLivingRepoMapMemoForTest(): void {
	livingRepoMapMemo.clear();
}

/**
 * Get the living repo map for `cwd`. Incremental against the last indexed
 * commit when possible; degrades to a full scan otherwise. Persists the updated
 * cache (best effort) unless running in the PIT_NO_LIVING_REPO_MAP escape mode.
 *
 * Never throws: any I/O failure degrades to a coarser-but-correct path.
 */
export async function getLivingRepoMap(
	cwd: string,
	deps: LivingRepoMapDeps = defaultLivingRepoMapDeps,
): Promise<LivingRepoMapResult> {
	const cachePath = deps.cachePath(cwd);
	// Repo graph kill-switch: with the flag, deps are neither extracted nor
	// persisted (entries fall back to symbols/decls-only, exactly like a v2-only
	// harness) and `graph.ts` naturally sees an all-nodes-no-edges map. Read
	// ONCE per call — every fullScan/indexFile call site below shares this value.
	const extractDepsEnabled = !isTruthyEnvFlag(process.env.PIT_NO_REPO_GRAPH);

	// Escape hatch: one-shot full scan, no persistence. Feature is ON by default;
	// this flag (when truthy) only DISABLES the incremental cache, never the map.
	if (isTruthyEnvFlag(process.env.PIT_NO_LIVING_REPO_MAP)) {
		return fullScan(cwd, "", deps, extractDepsEnabled);
	}

	const head = await deps.resolveHead(cwd);

	// Short-TTL memo: only for the default deps (see `livingRepoMapMemoKey` doc
	// comment) — non-default deps bypass it entirely so injectable-deps tests
	// keep driving exact scenarios. `memoize` below stores every result this
	// call produces; a hit here skips loadCache/gitDiff/the re-stat loop below.
	const memoKey = deps === defaultLivingRepoMapDeps ? livingRepoMapMemoKey(cwd, head) : null;
	if (memoKey) {
		const cached = livingRepoMapMemo.get(memoKey);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.result;
		}
	}
	const memoize = (result: LivingRepoMapResult): LivingRepoMapResult => {
		if (memoKey) {
			livingRepoMapMemo.set(memoKey, { result, expiresAt: Date.now() + LIVING_REPO_MAP_MEMO_TTL_MS });
		}
		return result;
	};

	// Non-git (or git unavailable): full scan, do not persist a commit anchor.
	// We still persist the symbol map with commit="" so a later git run starts
	// from real data instead of cold.
	if (head === null) {
		const result = await fullScan(cwd, "", deps, extractDepsEnabled);
		trySave(deps, cachePath, result.map);
		return memoize(result);
	}

	const cache = deps.loadCache(cachePath);

	// No usable cache, or cache anchored to a different/empty commit lineage:
	// if we have a cached commit, try the cheap incremental delta; otherwise
	// (no commit anchor at all) do a full scan once to seed the cache.
	if (!cache || cache.lastIndexedCommit.length === 0) {
		const result = await fullScan(cwd, head, deps, extractDepsEnabled);
		trySave(deps, cachePath, result.map);
		return memoize(result);
	}

	// Anchored cache present. Ask git for the committed delta since that commit.
	const diff = await deps.gitDiff(cwd, cache.lastIndexedCommit);

	// git diff failed (e.g. the cached commit was rebased away): rebuild fully.
	if (diff === null) {
		const result = await fullScan(cwd, head, deps, extractDepsEnabled);
		trySave(deps, cachePath, result.map);
		return memoize(result);
	}

	// Start from the cached entries, keyed for O(1) patch.
	const byPath = new Map<string, RepoMapEntry>();
	for (const e of cache.entries) byPath.set(e.path, e);

	// Seeded from the PRE-mutation cache keys — a cheap perf hint for edge
	// resolution (see makeFileExistsChecker); correctness for files added/renamed
	// DURING this pass still holds via its statMtime fallback.
	const fileExists = makeFileExistsChecker(cwd, deps, byPath.keys());

	let reindexed = 0;
	const changedKeys = new Set<string>();

	for (const entry of diff) {
		// Deleted: drop from the map. (Rename source is also dropped below.)
		if (entry.status === "D") {
			byPath.delete(toRelKey(cwd, entry.path));
			continue;
		}
		// Rename/copy: remove the old key, index the destination.
		const target = entry.renameTo ?? entry.path;
		if (entry.status === "R") byPath.delete(toRelKey(cwd, entry.path));
		const key = toRelKey(cwd, target);
		changedKeys.add(key);
		const fresh = indexFile(cwd, target, deps, fileExists, extractDepsEnabled);
		if (fresh) {
			byPath.set(key, fresh);
		} else {
			// Unreadable / no symbols now (e.g. file emptied) → remove stale entry.
			byPath.delete(key);
		}
		reindexed++;
	}

	// Working-tree drift: a file changed since the cached commit but with NO new
	// commit (uncommitted edit) won't appear in `<base>..HEAD`. Catch it by mtime
	// so the map reflects the live tree, not just the committed state. We only
	// re-stat cached entries (bounded) and skip ones already reindexed above.
	for (const e of cache.entries) {
		if (changedKeys.has(e.path)) continue;
		const abs = join(cwd, e.path);
		const mtime = deps.statMtime(abs);
		// mtime 0 = gone; a mismatch = edited in place. Either way, re-resolve.
		if (mtime === 0) {
			byPath.delete(e.path);
			continue;
		}
		if (mtime !== e.mtimeMs) {
			const fresh = indexFile(cwd, e.path, deps, fileExists, extractDepsEnabled);
			if (fresh) byPath.set(e.path, fresh);
			else byPath.delete(e.path);
			reindexed++;
		}
	}

	const result: LivingRepoMapResult = {
		map: { version: CACHE_VERSION, lastIndexedCommit: head, entries: Array.from(byPath.values()) },
		mode: reindexed > 0 ? "incremental" : "cache-hit",
		reindexedCount: reindexed,
	};
	trySave(deps, cachePath, result.map);
	return memoize(result);
}

/** Persist best-effort; a cache write failure must never break the caller. */
function trySave(deps: LivingRepoMapDeps, cachePath: string, map: LivingRepoMap): void {
	try {
		deps.saveCache(cachePath, map);
	} catch {
		// Advisory cache — swallow. Next run rebuilds.
	}
}

/**
 * Adapt the living map to the `Record<path, "sym1, sym2, …">` shape that the
 * compaction file-digests consume. Restricted to `forPaths` (the touched files
 * of a compaction) so the digest only covers what the turn actually used; pass
 * undefined to project the entire map.
 *
 * WIRED: this adapter is consumed by compaction. In
 * `packages/coding-agent/src/core/compaction/compaction.ts`, inside the
 * `if (digestPaths.length > 0)` block (~line 1520), the compaction path calls
 * `getLivingRepoMap(cwd)` + `livingRepoMapToDigests(map)` and passes the result
 * as the `preSeed` to `buildFileDigests`, so anything already indexed is NOT
 * re-read/re-parsed — the digest becomes a cache READ instead of a full rebuild.
 * Fail-open: if `getLivingRepoMap` returns a `full-scan` map (non-git), the seed
 * simply has fewer/all entries and `buildFileDigests` fills any gaps, so output
 * is identical; only the cost differs.
 */
export function livingRepoMapToDigests(map: LivingRepoMap, forPaths?: string[]): Record<string, string> {
	const want = forPaths ? new Set(forPaths.map((p) => p.split("\\").join("/"))) : undefined;
	const out: Record<string, string> = {};
	for (const e of map.entries) {
		if (want && !want.has(e.path)) continue;
		if (e.symbols.length === 0) continue;
		out[e.path] = e.symbols.join(", ");
	}
	return out;
}
