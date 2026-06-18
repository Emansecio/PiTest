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
import { listDeclarations } from "../tools/symbol.ts";

/** Bump when the on-disk schema changes incompatibly. */
const CACHE_VERSION = 1 as const;

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

/** One indexed file: relative path + its symbol names + the mtime we indexed at. */
export interface RepoMapEntry {
	/** cwd-relative, forward-slash-normalized path (stable across OSes). */
	path: string;
	/** Symbol names (capped), in declaration order. */
	symbols: string[];
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
 * Best-effort cache read. JSONL: line 0 is the header
 * `{version,lastIndexedCommit}`, each subsequent non-empty line is one
 * RepoMapEntry. A malformed line is skipped (advisory data, never load-bearing).
 */
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
			entries.push({ path: obj.path, symbols: obj.symbols.map(String), mtimeMs });
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
	loadCache: loadRepoMapCache,
	saveCache: saveRepoMapCache,
	cachePath: defaultRepoMapCachePath,
};

// --- Core flow ---------------------------------------------------------------

/** Index one file (abs path) into an entry, or null if it has no symbols/unreadable. */
function indexFile(cwd: string, relPath: string, deps: LivingRepoMapDeps): RepoMapEntry | null {
	const abs = isAbsolute(relPath) ? relPath : join(cwd, relPath);
	const content = deps.readFile(abs);
	if (content === null) return null;
	const symbols = deps.extractSymbols(content, abs);
	if (symbols.length === 0) return null;
	return { path: toRelKey(cwd, relPath), symbols, mtimeMs: deps.statMtime(abs) };
}

/** Build a fresh map from a full source-file walk (non-git / cold-start path). */
async function fullScan(cwd: string, commit: string, deps: LivingRepoMapDeps): Promise<LivingRepoMapResult> {
	const files = await deps.scan(cwd);
	const entries: RepoMapEntry[] = [];
	for (const file of files) {
		const entry = indexFile(cwd, file, deps);
		if (entry) entries.push(entry);
	}
	return {
		map: { version: CACHE_VERSION, lastIndexedCommit: commit, entries },
		mode: "full-scan",
		reindexedCount: entries.length,
	};
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

	// Escape hatch: one-shot full scan, no persistence. Feature is ON by default;
	// this flag (when truthy) only DISABLES the incremental cache, never the map.
	if (isTruthyEnvFlag(process.env.PIT_NO_LIVING_REPO_MAP)) {
		return fullScan(cwd, "", deps);
	}

	const head = await deps.resolveHead(cwd);

	// Non-git (or git unavailable): full scan, do not persist a commit anchor.
	// We still persist the symbol map with commit="" so a later git run starts
	// from real data instead of cold.
	if (head === null) {
		const result = await fullScan(cwd, "", deps);
		trySave(deps, cachePath, result.map);
		return result;
	}

	const cache = deps.loadCache(cachePath);

	// No usable cache, or cache anchored to a different/empty commit lineage:
	// if we have a cached commit, try the cheap incremental delta; otherwise
	// (no commit anchor at all) do a full scan once to seed the cache.
	if (!cache || cache.lastIndexedCommit.length === 0) {
		const result = await fullScan(cwd, head, deps);
		trySave(deps, cachePath, result.map);
		return result;
	}

	// Anchored cache present. Ask git for the committed delta since that commit.
	const diff = await deps.gitDiff(cwd, cache.lastIndexedCommit);

	// git diff failed (e.g. the cached commit was rebased away): rebuild fully.
	if (diff === null) {
		const result = await fullScan(cwd, head, deps);
		trySave(deps, cachePath, result.map);
		return result;
	}

	// Start from the cached entries, keyed for O(1) patch.
	const byPath = new Map<string, RepoMapEntry>();
	for (const e of cache.entries) byPath.set(e.path, e);

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
		const fresh = indexFile(cwd, target, deps);
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
			const fresh = indexFile(cwd, e.path, deps);
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
	return result;
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
 * WIRE POINT (do NOT edit compaction.ts from this lane — main loop wires it):
 *   In `packages/coding-agent/src/core/compaction/compaction.ts` at the
 *   `buildFileDigests(...)` call site (currently line ~1483, inside the
 *   `if (digestPaths.length > 0)` block, line ~1482), the main loop should:
 *     1. `const { map } = await getLivingRepoMap(cwd ?? ".");`  (top of the block)
 *     2. `const cached = livingRepoMapToDigests(map, digestPaths.map((p) => relative(cwd ?? ".", isAbsolute(p) ? p : resolve(cwd ?? ".", p))));`
 *     3. Pass `cached` as a pre-seed to `buildFileDigests` so files already in
 *        the map are NOT re-read/re-parsed — only cache-miss paths hit disk.
 *   This makes the digest a cache READ instead of a full rebuild. The import to
 *   add at compaction.ts:19 area:
 *     `import { getLivingRepoMap, livingRepoMapToDigests } from "../repo-map/living-index.ts";`
 *   Degradation: if `getLivingRepoMap` returns a `full-scan` map (non-git), the
 *   seed simply has fewer/all entries — `buildFileDigests` still fills any gaps,
 *   so correctness is unchanged; only the cost differs.
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
