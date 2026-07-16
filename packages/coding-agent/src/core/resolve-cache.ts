import { createHash } from "node:crypto";
import { type Dirent, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../config.ts";
import { isTruthyEnvFlag } from "../utils/env-flags.ts";
import { type FileStamp, isValidStamp, stampPath, stampsStillValidAsync } from "./file-stamps.ts";
import type { ResolvedPaths, ResolvedResource } from "./package-manager.ts";

/**
 * Disk cache for PackageManager.resolve() — the boot-time sync scan of
 * ~/.pit/agent (settings entries, installed packages, auto-discovery of
 * extensions/skills/prompts/themes) that costs ~100-320ms of readdir/exists/
 * realpath on every start. The full ResolvedPaths result is cached in
 * `<agentDir>/resolve-cache.json` and revalidated with one parallel stat
 * fan-out instead of the scan.
 *
 * Invalidation is fully automatic:
 *   - the *effective* settings content (global+project, as the SettingsManager
 *     hands it to resolve()) is hashed into the entry key — any settings edit,
 *     including in-memory ones, is a miss. This also neutralizes the boot-time
 *     settings.json rewrite (identical content → identical signature).
 *   - every directory consumed by the scan is stamped recursively (dir mtime
 *     changes when a child is added/removed/renamed, so a new skill/extension
 *     anywhere in a watched tree bumps a stamped dir).
 *   - files whose *content or mtime* changes the result are stamped
 *     individually: package.json (pi manifests), ignore files
 *     (.gitignore/.ignore/.fdignore), and .ts/.tsx/.js entries (the compiled-
 *     sibling preference compares file mtimes — editing index.ts must flip the
 *     resolved entry back to the live source).
 *   - ancestor `.git` probes are existence-only stamps (their mtime churns).
 *   - a stamp budget caps pathological trees; exceeding it skips caching
 *     entirely (always-live behavior, never staleness).
 *
 * Escape hatch: PIT_NO_RESOLVE_CACHE=1 disables both read and write.
 */

const RESOLVE_CACHE_FILE = "resolve-cache.json";
const RESOLVE_CACHE_SCHEMA = 1;
/** Keep the most recent cwds only, so alternating projects don't grow the file. */
const RESOLVE_CACHE_MAX_ENTRIES = 8;
/**
 * Hard cap on recorded stamps. Validation is a parallel stat fan-out (~µs per
 * entry of wall time); past this size the fingerprint itself would start to
 * rival the scan it replaces, so we just don't cache.
 */
const MAX_STAMPS = 4000;
/** Belt-and-suspenders recursion cap (symlink cycles resolve to repeat dirs). */
const MAX_STAMP_WALK_DEPTH = 16;

const IGNORE_FILE_NAMES = new Set([".gitignore", ".ignore", ".fdignore"]);
/** File types whose mtime/content participates in resolve()'s output. */
const RELEVANT_FILE_RE = /\.(ts|tsx|js)$/;

export interface ResolveWatchSet {
	/** Roots stamped recursively (missing roots are stamped as missing). */
	treeRoots: string[];
	/** Paths where only existence+kind matters (ancestor .git probes). */
	existencePaths: string[];
}

export interface ResolveCacheKey {
	agentDir: string;
	cwd: string;
	/** getHomeDir() — ~/.agents/skills and tilde expansion depend on it. */
	homeDir: string;
	/** sha1 of the effective global+project settings resolve() consumes. */
	settingsSignature: string;
}

interface ResolveCacheEntry {
	/** Pit version that produced the result (a self-update invalidates). */
	version: string;
	cwd: string;
	homeDir: string;
	settingsSignature: string;
	stamps: FileStamp[];
	result: ResolvedPaths;
}

interface ResolveCacheFile {
	schema: number;
	entries: ResolveCacheEntry[];
}

export function computeSettingsSignature(globalSettings: unknown, projectSettings: unknown): string {
	return createHash("sha1")
		.update(JSON.stringify([globalSettings ?? null, projectSettings ?? null]))
		.digest("hex");
}

function resolveCachePath(agentDir: string): string {
	return join(agentDir, RESOLVE_CACHE_FILE);
}

function timingLog(message: string): void {
	if (process.env.PIT_TIMING === "1") {
		console.error(`  [perf] resolve-cache: ${message}`);
	}
}

/**
 * Stamp a watch root recursively. Directories get mtime stamps; files whose
 * content/mtime feeds the resolve output (package.json, ignore files, ts/js
 * entries) get strict mtime+size stamps. Everything else is covered by its
 * parent directory's mtime (add/remove/rename). Traversal skips dot entries
 * (except ignore files) and node_modules, mirroring the discovery walks in
 * package-manager.ts, so the fingerprint watches a superset of what the scan
 * actually reads (over-invalidation is safe; staleness is not).
 *
 * Returns false when the stamp budget is exhausted (caller must not cache).
 */
function stampTree(root: string, out: Map<string, FileStamp>, depth = 0): boolean {
	if (out.size >= MAX_STAMPS) {
		return false;
	}
	if (out.has(root)) {
		return true;
	}
	const rootStamp = stampPath(root, { hash: false });
	out.set(root, rootStamp);
	if (rootStamp.kind !== "dir" || depth > MAX_STAMP_WALK_DEPTH) {
		return true;
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(root, { withFileTypes: true });
	} catch {
		return true;
	}
	for (const entry of entries) {
		if (out.size >= MAX_STAMPS) {
			return false;
		}
		const name = entry.name;
		if (name === "node_modules") {
			continue;
		}
		if (name.startsWith(".") && !IGNORE_FILE_NAMES.has(name)) {
			continue;
		}
		const fullPath = join(root, name);
		let isDir = entry.isDirectory();
		let isFile = entry.isFile();
		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(fullPath);
				isDir = stats.isDirectory();
				isFile = stats.isFile();
			} catch {
				continue;
			}
		}
		if (isDir) {
			if (!stampTree(fullPath, out, depth + 1)) {
				return false;
			}
		} else if (isFile && (name === "package.json" || IGNORE_FILE_NAMES.has(name) || RELEVANT_FILE_RE.test(name))) {
			if (!out.has(fullPath)) {
				out.set(fullPath, stampPath(fullPath, { hash: false }));
			}
		}
	}
	return true;
}

function isValidMetadata(value: unknown): boolean {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const m = value as { source?: unknown; scope?: unknown; origin?: unknown; baseDir?: unknown };
	return (
		typeof m.source === "string" &&
		(m.scope === "user" || m.scope === "project" || m.scope === "temporary") &&
		(m.origin === "package" || m.origin === "top-level") &&
		(m.baseDir === undefined || typeof m.baseDir === "string")
	);
}

function isValidResource(value: unknown): value is ResolvedResource {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const r = value as Partial<ResolvedResource>;
	return typeof r.path === "string" && typeof r.enabled === "boolean" && isValidMetadata(r.metadata);
}

function isValidResult(value: unknown): value is ResolvedPaths {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const result = value as Partial<ResolvedPaths>;
	for (const key of ["extensions", "skills", "prompts", "themes"] as const) {
		const list = result[key];
		if (!Array.isArray(list) || !list.every(isValidResource)) {
			return false;
		}
	}
	return true;
}

function readCacheFile(agentDir: string): ResolveCacheEntry[] {
	try {
		const file = JSON.parse(readFileSync(resolveCachePath(agentDir), "utf8")) as Partial<ResolveCacheFile>;
		if (file.schema === RESOLVE_CACHE_SCHEMA && Array.isArray(file.entries)) {
			return file.entries;
		}
	} catch {
		// Missing/corrupt cache — treated as empty.
	}
	return [];
}

function entryMatchesKey(entry: ResolveCacheEntry | undefined, key: ResolveCacheKey): boolean {
	return (
		!!entry &&
		entry.version === VERSION &&
		entry.cwd === key.cwd &&
		entry.homeDir === key.homeDir &&
		entry.settingsSignature === key.settingsSignature
	);
}

/**
 * Return the cached ResolvedPaths when the entry key matches and every
 * recorded fingerprint still holds; undefined on any miss (caller falls back
 * to the live scan, which rewrites the cache).
 */
export async function readResolveCache(key: ResolveCacheKey): Promise<ResolvedPaths | undefined> {
	if (isTruthyEnvFlag(process.env.PIT_NO_RESOLVE_CACHE)) {
		return undefined;
	}
	const entry = readCacheFile(key.agentDir).find((e) => e?.cwd === key.cwd && e.version === VERSION);
	if (!entryMatchesKey(entry, key)) {
		timingLog("miss (no entry / settings changed)");
		return undefined;
	}
	if (!entry || !Array.isArray(entry.stamps) || !entry.stamps.every(isValidStamp) || !isValidResult(entry.result)) {
		timingLog("miss (malformed entry)");
		return undefined;
	}
	if (!(await stampsStillValidAsync(entry.stamps))) {
		timingLog(`miss (fingerprint drift, ${entry.stamps.length} stamps)`);
		return undefined;
	}
	timingLog(`hit (${entry.stamps.length} stamps)`);
	return entry.result;
}

/**
 * Record a freshly computed ResolvedPaths plus the fingerprint of everything
 * it depends on. Best-effort: any failure (or a blown stamp budget) just
 * leaves resolve() on the live path.
 */
export function writeResolveCache(options: {
	key: ResolveCacheKey;
	watch: ResolveWatchSet;
	result: ResolvedPaths;
}): void {
	if (isTruthyEnvFlag(process.env.PIT_NO_RESOLVE_CACHE)) {
		return;
	}
	try {
		const { key, watch, result } = options;
		const stamps = new Map<string, FileStamp>();
		for (const root of watch.treeRoots) {
			if (!stampTree(root, stamps)) {
				timingLog(`not cached (stamp budget of ${MAX_STAMPS} exceeded)`);
				return;
			}
		}
		for (const path of watch.existencePaths) {
			if (!stamps.has(path)) {
				stamps.set(path, stampPath(path, { existenceOnly: true }));
			}
		}
		const entry: ResolveCacheEntry = {
			version: VERSION,
			cwd: key.cwd,
			homeDir: key.homeDir,
			settingsSignature: key.settingsSignature,
			stamps: [...stamps.values()],
			result,
		};
		const others = readCacheFile(key.agentDir).filter((e) => !(e?.cwd === key.cwd && e.version === VERSION));
		const file: ResolveCacheFile = {
			schema: RESOLVE_CACHE_SCHEMA,
			entries: [entry, ...others].slice(0, RESOLVE_CACHE_MAX_ENTRIES),
		};
		mkdirSync(key.agentDir, { recursive: true });
		writeFileSync(resolveCachePath(key.agentDir), `${JSON.stringify(file)}\n`, "utf8");
	} catch {
		// Best-effort cache — resolve() just stays on the live path.
	}
}
