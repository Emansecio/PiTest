/**
 * Fingerprint cache for scripts/check-token-bench.mjs (audit 6.5).
 *
 * The token-bench gate is ~100% of the pre-commit critical path (check:static
 * measured total=5919ms token-bench=5918ms). Its four tsx benches are pure
 * functions of on-disk inputs, so on the pre-commit path we skip them when a
 * conservative fingerprint of every input matches the one recorded at the last
 * PASS. Pre-push (`npm run check`) and CI always run for real — the caller
 * (check-parallel.mjs) only passes `--cache` on the --no-vitest path, and this
 * module additionally refuses to engage when `CI` is set.
 *
 * Input set (false "cached ok" is unacceptable; a false miss is only cost):
 *  - Source trees the benches import (verified by reading their import graphs):
 *    packages/coding-agent/src, packages/ai/src, packages/agent/src
 *    (@pit/agent-core), scripts/lib. Aggregated as a digest over sorted
 *    (relative path, size, mtimeMs) — a stat-only walk, no content reads.
 *  - The gate itself: the four bench-*.mts scripts, check-token-bench.mjs,
 *    scripts/baselines/token-economy.json.
 *  - Root configs read at bench runtime (project-config-context.ts) or that
 *    move the dependency graph: tsconfig*.json, biome.json(c), package.json,
 *    package-lock.json.
 *  - Environment-dependent prompt inputs (bench-prompt-size/session-tokens read
 *    these live): AGENTS.md/CLAUDE.md + legacy rule files/dirs (cursor, cline,
 *    gemini, copilot, windsurf, vscode) at the bench root, the local root, and
 *    every ancestor directory (loadProjectContextFiles walks up to the fs
 *    root); the same set under ~/.pit/agent; and every SKILL.md under
 *    ~/.pit/agent/skills (the skill catalog feeds the wire-prefix max rules).
 *    These live outside the repo trees, so they get individual stamps in the
 *    help-cache.ts style: stat (mtime+size) fast path with a sha1 content-hash
 *    fallback — Pit rewrites some of its home-dir files on every boot with
 *    identical bytes, so an mtime-only stamp would self-invalidate. Missing
 *    paths are recorded too, so a file APPEARING is a miss.
 *  - bench-compaction-fidelity's fabricated-path probe (src/fabricated/ghost.ts
 *    must not exist) and the PIT_* env flags that shape the measured tool
 *    surface (e.g. PIT_NO_CODE_MODE, PIT_NARRATION) + process.version.
 *
 * Cache location: node_modules/.cache/pit-token-bench.json under the checkout
 * that runs the gate. Per-checkout by construction (a linked worktree has its
 * own node_modules; no node_modules means no cache, benches just run), never
 * committed, and standard tool-cache territory. Only a PASS is recorded.
 *
 * Escape hatch: PIT_NO_BENCH_CACHE=1 disables read and write.
 * Debug: PIT_BENCH_CACHE_DEBUG=<file> dumps the digest input lines to <file>
 * (diff two dumps to see exactly which input caused a miss). Both knobs are
 * excluded from the fingerprint — they never reach the benches.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const CACHE_SCHEMA = 1;

/** Source trees (relative to repo root) aggregated stat-only into the digest. */
const INPUT_TREES = ["packages/coding-agent/src", "packages/ai/src", "packages/agent/src", "scripts/lib"];

/** Single repo files stat-stamped into the digest. */
const INPUT_FILES = [
	"scripts/bench-session-tokens.mts",
	"scripts/bench-prompt-size.mts",
	"scripts/bench-fusion-tokens.mts",
	"scripts/bench-compaction-fidelity.mts",
	"scripts/check-token-bench.mjs",
	"scripts/baselines/token-economy.json",
	"package.json",
	"package-lock.json",
	"biome.json",
	"biome.jsonc",
];

/** Context files loadAllContextFilesFromDir/loadContextFiles probe per directory. */
const CONTEXT_FILE_CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

/** Single legacy rule files discoverLegacyResources probes per root. */
const LEGACY_SINGLE_RULE_FILES = [
	".claude/CLAUDE.md",
	".cursorrules",
	".clinerules",
	".cline/.clinerules",
	".gemini/GEMINI.md",
	"GEMINI.md",
	".github/copilot-instructions.md",
];

/** Legacy rule DIRECTORIES discoverLegacyResources scans per root. */
const LEGACY_RULE_DIRS = [".cursor/rules", ".windsurf/rules", ".github/instructions", ".vscode/instructions"];

/**
 * Mirror of scripts/lib/bench-root.mts (that one is .mts and needs tsx): when
 * `root` is a linked git worktree, the benches measure against the MAIN
 * checkout root — its context/config files are inputs too.
 */
export function resolveBenchRootLike(root) {
	try {
		const gitPath = join(root, ".git");
		if (!existsSync(gitPath) || !statSync(gitPath).isFile()) return root;
		const match = readFileSync(gitPath, "utf8").match(/^gitdir:\s*(.+)$/m);
		if (!match) return root;
		const gitDir = resolve(root, match[1].trim());
		const worktreesDir = dirname(gitDir);
		if (basename(worktreesDir) !== "worktrees") return root;
		const dotGit = dirname(worktreesDir);
		if (basename(dotGit) !== ".git") return root;
		const mainRoot = dirname(dotGit);
		return existsSync(join(mainRoot, "package.json")) ? mainRoot : root;
	} catch {
		return root;
	}
}

function sha1File(path) {
	try {
		return createHash("sha1").update(readFileSync(path)).digest("hex");
	} catch {
		return null;
	}
}

/** help-cache.ts stampPath: stat identity + content hash for files. */
function stampPath(path) {
	try {
		const stats = statSync(path);
		if (stats.isDirectory()) {
			return { path, kind: "dir", mtimeMs: stats.mtimeMs, size: null, hash: null };
		}
		return { path, kind: "file", mtimeMs: stats.mtimeMs, size: stats.size, hash: sha1File(path) };
	} catch {
		return { path, kind: "missing", mtimeMs: null, size: null, hash: null };
	}
}

/**
 * help-cache.ts stampStillValid: stat identity match is the fast path (no
 * reads); an mtime bump with identical bytes still matches (content-hash
 * fallback — boot rewrites some files with identical bytes); directories match
 * on mtime; missing paths must still be missing.
 */
function stampStillValid(stamp) {
	let stats;
	try {
		stats = statSync(stamp.path);
	} catch {
		stats = undefined;
	}
	if (!stats) return stamp.kind === "missing";
	if (stats.isDirectory()) return stamp.kind === "dir" && stats.mtimeMs === stamp.mtimeMs;
	if (stamp.kind !== "file") return false;
	if (stats.mtimeMs === stamp.mtimeMs && stats.size === stamp.size) return true;
	return stamp.hash !== null && stats.size === stamp.size && sha1File(stamp.path) === stamp.hash;
}

function listTreeStats(repoRoot, treeRel, lines) {
	const treeAbs = join(repoRoot, treeRel);
	let entries;
	try {
		entries = readdirSync(treeAbs, { recursive: true, withFileTypes: true });
	} catch {
		lines.push(`tree:${treeRel}:missing`);
		return;
	}
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const abs = join(entry.parentPath ?? entry.path, entry.name);
		try {
			const stats = statSync(abs);
			lines.push(`${treeRel}/${relative(treeAbs, abs).replaceAll("\\", "/")}:${stats.size}:${stats.mtimeMs}`);
		} catch {
			lines.push(`${treeRel}/${relative(treeAbs, abs).replaceAll("\\", "/")}:unstattable`);
		}
	}
}

/** Every directory whose context/legacy rule files the benches can read. */
function contextRoots(repoRoot, benchRoot) {
	const roots = new Set([resolve(repoRoot), resolve(benchRoot)]);
	// loadProjectContextFiles walks from the bench root up to the fs root.
	let current = resolve(benchRoot);
	while (true) {
		const parent = dirname(current);
		if (parent === current) break;
		roots.add(parent);
		current = parent;
	}
	return [...roots];
}

/** Paths OUTSIDE the aggregated repo trees, individually stamped. */
function volatileStampPaths(repoRoot, benchRoot, agentDir) {
	const paths = new Set();
	const roots = contextRoots(repoRoot, benchRoot);
	roots.push(agentDir); // loadProjectContextFiles + legacy discovery also scan agentDir
	for (const root of roots) {
		for (const rel of [...CONTEXT_FILE_CANDIDATES, ...LEGACY_SINGLE_RULE_FILES]) {
			paths.add(join(root, rel));
		}
		for (const rel of LEGACY_RULE_DIRS) {
			const dir = join(root, rel);
			paths.add(dir);
			try {
				for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
					if (entry.isFile()) paths.add(join(entry.parentPath ?? entry.path, entry.name));
				}
			} catch {
				// dir missing — its stamp records that; appearance invalidates.
			}
		}
	}
	// Root configs the benches read live from the (possibly distinct) bench root.
	for (const root of new Set([resolve(repoRoot), resolve(benchRoot)])) {
		for (const name of ["tsconfig.json", "biome.json", "biome.jsonc"]) paths.add(join(root, name));
		try {
			for (const name of readdirSync(root)) {
				if (/^tsconfig.*\.json$/.test(name)) paths.add(join(root, name));
			}
		} catch {}
	}
	// Skill catalog: dir stamp catches entries added/removed; per-entry SKILL.md
	// stamps (missing ones included) catch edits and late appearance.
	const skillsDir = join(agentDir, "skills");
	paths.add(skillsDir);
	try {
		for (const entry of readdirSync(skillsDir)) {
			paths.add(join(skillsDir, entry, "SKILL.md"));
		}
	} catch {}
	// bench-compaction-fidelity asserts this path does NOT exist on disk.
	paths.add(join(repoRoot, "src", "fabricated", "ghost.ts"));
	return [...paths].sort();
}

/**
 * Compute the full fingerprint: an aggregate digest over the repo input trees
 * plus individual stamps for everything outside them. Throws only never —
 * callers treat any internal failure as a cache miss.
 */
export function computeFingerprint(repoRoot) {
	const started = Date.now();
	const benchRoot = resolveBenchRootLike(resolve(repoRoot));
	const agentDir = join(homedir(), ".pit", "agent");

	const lines = [];
	for (const tree of INPUT_TREES) listTreeStats(repoRoot, tree, lines);
	for (const rel of INPUT_FILES) {
		try {
			const stats = statSync(join(repoRoot, rel));
			lines.push(`${rel}:${stats.size}:${stats.mtimeMs}`);
		} catch {
			lines.push(`${rel}:missing`);
		}
	}
	lines.sort();
	// PIT_* flags can change the measured tool surface / prompt (PIT_NO_CODE_MODE,
	// PIT_NARRATION, ...). Include them all: a toggled flag is at worst a miss.
	// The cache's own knobs are excluded — they never reach the benches.
	const CACHE_OWN_ENV = new Set(["PIT_NO_BENCH_CACHE", "PIT_BENCH_CACHE_DEBUG"]);
	const envBits = Object.keys(process.env)
		.filter((key) => key.startsWith("PIT_") && !CACHE_OWN_ENV.has(key))
		.sort()
		.map((key) => `${key}=${process.env[key]}`);
	lines.push(`node:${process.version}`, ...envBits);

	const digest = createHash("sha256").update(lines.join("\n")).digest("hex");
	if (process.env.PIT_BENCH_CACHE_DEBUG) {
		try {
			writeFileSync(process.env.PIT_BENCH_CACHE_DEBUG, lines.join("\n"), "utf8");
		} catch {}
	}
	const stamps = volatileStampPaths(repoRoot, benchRoot, agentDir).map(stampPath);
	return { digest, stamps, fileCount: lines.length, ms: Date.now() - started };
}

function cacheFilePath(repoRoot) {
	return join(repoRoot, "node_modules", ".cache", "pit-token-bench.json");
}

/**
 * True when the last recorded PASS fingerprint still matches the working tree.
 * `fingerprint` must be the freshly computed one (its digest is compared; the
 * STORED stamps are re-validated so the content-hash fallback applies).
 */
export function cachedPassStillValid(repoRoot, fingerprint) {
	try {
		const file = JSON.parse(readFileSync(cacheFilePath(repoRoot), "utf8"));
		if (file?.schema !== CACHE_SCHEMA) return false;
		const entry = file.entry;
		if (!entry || entry.root !== resolve(repoRoot) || entry.digest !== fingerprint.digest) return false;
		if (!Array.isArray(entry.stamps) || entry.stamps.length === 0) return false;
		return entry.stamps.every((stamp) => stamp && typeof stamp.path === "string" && stampStillValid(stamp));
	} catch {
		return false;
	}
}

/** Record a PASS. Best-effort: on any failure the next run just re-benches. */
export function writeCachedPass(repoRoot, fingerprint) {
	try {
		const path = cacheFilePath(repoRoot);
		mkdirSync(dirname(path), { recursive: true });
		const file = {
			schema: CACHE_SCHEMA,
			entry: {
				root: resolve(repoRoot),
				digest: fingerprint.digest,
				stamps: fingerprint.stamps,
				savedAt: new Date().toISOString(),
			},
		};
		writeFileSync(path, `${JSON.stringify(file, null, "\t")}\n`, "utf8");
	} catch {
		// no node_modules (or unwritable) — cache simply stays cold.
	}
}
