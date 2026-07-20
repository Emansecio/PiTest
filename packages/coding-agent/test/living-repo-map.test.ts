import { describe, expect, it } from "vitest";
import {
	getLivingRepoMap,
	type LivingRepoMap,
	type LivingRepoMapDeps,
	livingRepoMapToDigests,
	loadRepoMapCache,
	saveRepoMapCache,
} from "../src/core/repo-map/living-index.js";

const CWD = "/proj";

/**
 * Build a deps harness with in-memory fs + scriptable git. Tracks how many times
 * each file was parsed so tests can assert "only the changed file was reindexed".
 */
function makeDeps(opts: {
	head: string | null;
	diff?: Array<{ status: string; path: string; renameTo?: string }> | null;
	cache?: LivingRepoMap;
	files: Record<string, string>;
	mtimes?: Record<string, number>;
	/**
	 * OPTIONAL edge extractor. Omitted by default (matches the pre-repo-graph
	 * harness exactly: `deps.extractDeps` stays undefined, so `indexFile` never
	 * touches it) — only the repo-graph-specific tests below wire it.
	 */
	extractDeps?: (content: string, path: string, fileExists: (p: string) => boolean) => string[];
}): {
	deps: LivingRepoMapDeps;
	parseCounts: Record<string, number>;
	depsExtractCounts: Record<string, number>;
	saved: { calls: number; last?: LivingRepoMap };
} {
	const parseCounts: Record<string, number> = {};
	const depsExtractCounts: Record<string, number> = {};
	const saved: { calls: number; last?: LivingRepoMap } = { calls: 0 };
	const norm = (p: string) => p.split("\\").join("/");
	const abs = (rel: string) => (rel.startsWith("/") ? rel : `${CWD}/${rel}`);
	const rel = (p: string) => norm(p).replace(`${CWD}/`, "");

	const deps: LivingRepoMapDeps = {
		resolveHead: async () => opts.head,
		gitDiff: async () =>
			opts.diff === undefined
				? null
				: opts.diff === null
					? null
					: opts.diff.map((d) => ({
							status: d.status as never,
							path: d.path,
							renameTo: d.renameTo,
						})),
		readFile: (absPath) => {
			const key = rel(absPath);
			return opts.files[key] ?? null;
		},
		statMtime: (absPath) => {
			const key = rel(absPath);
			return opts.mtimes?.[key] ?? (opts.files[key] !== undefined ? 1 : 0);
		},
		scan: async () => Object.keys(opts.files).map((f) => abs(f)),
		extractSymbols: (content, path) => {
			const key = rel(path);
			parseCounts[key] = (parseCounts[key] ?? 0) + 1;
			// Trivial "parser": each non-empty line is a symbol name.
			return content
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.length > 0);
		},
		extractDeps: opts.extractDeps
			? (content, path, fileExists) => {
					const key = rel(path);
					depsExtractCounts[key] = (depsExtractCounts[key] ?? 0) + 1;
					return opts.extractDeps!(content, path, fileExists);
				}
			: undefined,
		loadCache: () => opts.cache,
		saveCache: (_path, map) => {
			saved.calls++;
			saved.last = map;
		},
		cachePath: () => `${CWD}/.pit/repo-map.jsonl`,
	};
	return { deps, parseCounts, depsExtractCounts, saved };
}

describe("getLivingRepoMap — incremental git delta", () => {
	it("reindexes ONLY the modified file, keeps the rest, persists new HEAD", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "old-sha",
			entries: [
				{ path: "a.ts", symbols: ["aOld"], mtimeMs: 1 },
				{ path: "b.ts", symbols: ["bKept"], mtimeMs: 1 },
			],
		};
		const { deps, parseCounts, saved } = makeDeps({
			head: "new-sha",
			diff: [{ status: "M", path: "a.ts" }],
			cache,
			files: { "a.ts": "aNew", "b.ts": "bKept" },
			mtimes: { "a.ts": 1, "b.ts": 1 }, // b unchanged → no mtime drift
		});

		const result = await getLivingRepoMap(CWD, deps);

		// Only a.ts was parsed; b.ts kept verbatim from cache (no parse).
		expect(parseCounts["a.ts"]).toBe(1);
		expect(parseCounts["b.ts"]).toBeUndefined();
		expect(result.mode).toBe("incremental");
		expect(result.reindexedCount).toBe(1);

		const byPath = Object.fromEntries(result.map.entries.map((e) => [e.path, e.symbols]));
		expect(byPath["a.ts"]).toEqual(["aNew"]); // freshly indexed
		expect(byPath["b.ts"]).toEqual(["bKept"]); // untouched

		// Cache persisted with the NEW head sha.
		expect(saved.calls).toBe(1);
		expect(saved.last?.lastIndexedCommit).toBe("new-sha");
	});

	it("drops deleted files from the map", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "old-sha",
			entries: [
				{ path: "a.ts", symbols: ["a"], mtimeMs: 1 },
				{ path: "gone.ts", symbols: ["g"], mtimeMs: 1 },
			],
		};
		const { deps } = makeDeps({
			head: "new-sha",
			diff: [{ status: "D", path: "gone.ts" }],
			cache,
			files: { "a.ts": "a" },
			mtimes: { "a.ts": 1 },
		});
		const result = await getLivingRepoMap(CWD, deps);
		const paths = result.map.entries.map((e) => e.path);
		expect(paths).toContain("a.ts");
		expect(paths).not.toContain("gone.ts");
	});

	it("handles a rename: old key dropped, destination indexed", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "old-sha",
			entries: [{ path: "old.ts", symbols: ["x"], mtimeMs: 1 }],
		};
		const { deps, parseCounts } = makeDeps({
			head: "new-sha",
			diff: [{ status: "R", path: "old.ts", renameTo: "new.ts" }],
			cache,
			files: { "new.ts": "renamed" },
			mtimes: { "new.ts": 1 },
		});
		const result = await getLivingRepoMap(CWD, deps);
		const paths = result.map.entries.map((e) => e.path);
		expect(paths).toEqual(["new.ts"]);
		expect(parseCounts["new.ts"]).toBe(1);
		expect(parseCounts["old.ts"]).toBeUndefined();
	});

	it("catches an uncommitted edit via mtime drift (not in the git diff)", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "head-sha",
			entries: [
				{ path: "a.ts", symbols: ["aOld"], mtimeMs: 1 },
				{ path: "b.ts", symbols: ["bOld"], mtimeMs: 1 },
			],
		};
		// HEAD unchanged (diff empty) but a.ts edited in the working tree (mtime 2).
		const { deps, parseCounts } = makeDeps({
			head: "head-sha",
			diff: [],
			cache,
			files: { "a.ts": "aEdited", "b.ts": "bOld" },
			mtimes: { "a.ts": 2, "b.ts": 1 },
		});
		const result = await getLivingRepoMap(CWD, deps);
		expect(parseCounts["a.ts"]).toBe(1); // re-parsed due to mtime mismatch
		expect(parseCounts["b.ts"]).toBeUndefined(); // mtime matched → kept
		const byPath = Object.fromEntries(result.map.entries.map((e) => [e.path, e.symbols]));
		expect(byPath["a.ts"]).toEqual(["aEdited"]);
		expect(result.reindexedCount).toBe(1);
	});

	it("pure cache hit when nothing changed → mode cache-hit, zero reindex", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "head-sha",
			entries: [{ path: "a.ts", symbols: ["a"], mtimeMs: 5 }],
		};
		const { deps, parseCounts } = makeDeps({
			head: "head-sha",
			diff: [],
			cache,
			files: { "a.ts": "a" },
			mtimes: { "a.ts": 5 },
		});
		const result = await getLivingRepoMap(CWD, deps);
		expect(result.mode).toBe("cache-hit");
		expect(result.reindexedCount).toBe(0);
		expect(Object.keys(parseCounts)).toHaveLength(0); // nothing parsed at all
	});
});

describe("getLivingRepoMap — degradation", () => {
	it("non-git repo falls back to a FULL scan, no commit anchor persisted", async () => {
		const { deps, parseCounts, saved } = makeDeps({
			head: null, // resolveHead → null = not a git repo
			files: { "a.ts": "aSym", "b.ts": "bSym" },
		});
		const result = await getLivingRepoMap(CWD, deps);
		expect(result.mode).toBe("full-scan");
		// Every scanned file parsed (full rebuild).
		expect(parseCounts["a.ts"]).toBe(1);
		expect(parseCounts["b.ts"]).toBe(1);
		// Persisted but WITHOUT a commit anchor.
		expect(saved.last?.lastIndexedCommit).toBe("");
	});

	it("git diff failure (rebased-away base) triggers a full rebuild at HEAD", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "dangling-sha",
			entries: [{ path: "a.ts", symbols: ["stale"], mtimeMs: 1 }],
		};
		const { deps, parseCounts, saved } = makeDeps({
			head: "new-sha",
			diff: null, // git diff failed
			cache,
			files: { "a.ts": "fresh", "c.ts": "cSym" },
		});
		const result = await getLivingRepoMap(CWD, deps);
		expect(result.mode).toBe("full-scan");
		expect(parseCounts["a.ts"]).toBe(1);
		expect(parseCounts["c.ts"]).toBe(1);
		expect(saved.last?.lastIndexedCommit).toBe("new-sha");
	});

	it("PIT_NO_LIVING_REPO_MAP forces a one-shot full scan with NO persistence", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "old-sha",
			entries: [{ path: "a.ts", symbols: ["a"], mtimeMs: 1 }],
		};
		const { deps, parseCounts, saved } = makeDeps({
			head: "new-sha",
			diff: [{ status: "M", path: "a.ts" }],
			cache,
			files: { "a.ts": "a", "b.ts": "b" },
		});
		const prev = process.env.PIT_NO_LIVING_REPO_MAP;
		process.env.PIT_NO_LIVING_REPO_MAP = "1";
		try {
			const result = await getLivingRepoMap(CWD, deps);
			expect(result.mode).toBe("full-scan");
			expect(parseCounts["a.ts"]).toBe(1);
			expect(parseCounts["b.ts"]).toBe(1);
			expect(saved.calls).toBe(0); // escape mode never persists
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_LIVING_REPO_MAP;
			else process.env.PIT_NO_LIVING_REPO_MAP = prev;
		}
	});

	it("no cached commit anchor → full scan to seed, then persists HEAD", async () => {
		const { deps, parseCounts, saved } = makeDeps({
			head: "new-sha",
			diff: [{ status: "M", path: "a.ts" }],
			cache: { version: 3, lastIndexedCommit: "", entries: [] }, // empty anchor
			files: { "a.ts": "a", "b.ts": "b" },
		});
		const result = await getLivingRepoMap(CWD, deps);
		expect(result.mode).toBe("full-scan");
		// Did NOT take the incremental path (would have parsed only a.ts).
		expect(parseCounts["b.ts"]).toBe(1);
		expect(saved.last?.lastIndexedCommit).toBe("new-sha");
	});
});

describe("getLivingRepoMap — repo graph (deps) extraction", () => {
	// Trivial test "parser": a line "dep:X" declares an edge to X.
	const extractDepLines = (content: string) =>
		content
			.split("\n")
			.filter((l) => l.startsWith("dep:"))
			.map((l) => l.slice(4));

	it("extracts deps ONLY for the reindexed file, in the SAME pass as symbols", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "old-sha",
			entries: [
				{ path: "a.ts", symbols: ["aOld"], mtimeMs: 1 },
				{ path: "b.ts", symbols: ["bKept"], mtimeMs: 1 },
			],
		};
		const { deps, depsExtractCounts, saved } = makeDeps({
			head: "new-sha",
			diff: [{ status: "M", path: "a.ts" }],
			cache,
			files: { "a.ts": "aNew\ndep:b.ts", "b.ts": "bKept" },
			mtimes: { "a.ts": 1, "b.ts": 1 },
			extractDeps: (content) => extractDepLines(content),
		});

		const result = await getLivingRepoMap(CWD, deps);

		expect(depsExtractCounts["a.ts"]).toBe(1);
		expect(depsExtractCounts["b.ts"]).toBeUndefined(); // unchanged -> not reindexed -> not re-extracted

		const byPath = Object.fromEntries(result.map.entries.map((e) => [e.path, e.deps]));
		expect(byPath["a.ts"]).toEqual(["b.ts"]);
		expect(byPath["b.ts"]).toBeUndefined(); // kept verbatim from a v3 cache entry with no deps

		// Persisted cache carries the new deps field.
		const savedA = saved.last?.entries.find((e) => e.path === "a.ts");
		expect(savedA?.deps).toEqual(["b.ts"]);
	});

	it("a renamed file's deps are re-extracted (not carried over from the old path)", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "old-sha",
			entries: [{ path: "old.ts", symbols: ["x"], deps: ["stale.ts"], mtimeMs: 1 }],
		};
		const { deps } = makeDeps({
			head: "new-sha",
			diff: [{ status: "R", path: "old.ts", renameTo: "new.ts" }],
			cache,
			files: { "new.ts": "renamed\ndep:fresh.ts" },
			mtimes: { "new.ts": 1 },
			extractDeps: (content) => extractDepLines(content),
		});
		const result = await getLivingRepoMap(CWD, deps);
		const byPath = Object.fromEntries(result.map.entries.map((e) => [e.path, e.deps]));
		expect(byPath["new.ts"]).toEqual(["fresh.ts"]);
		expect(byPath["old.ts"]).toBeUndefined();
	});

	it("full scan wires deps for every file too", async () => {
		const { deps } = makeDeps({
			head: null, // non-git -> full scan
			files: { "a.ts": "aSym\ndep:b.ts", "b.ts": "bSym" },
			extractDeps: (content) => extractDepLines(content),
		});
		const result = await getLivingRepoMap(CWD, deps);
		const byPath = Object.fromEntries(result.map.entries.map((e) => [e.path, e.deps]));
		expect(byPath["a.ts"]).toEqual(["b.ts"]);
		expect(byPath["b.ts"]).toBeUndefined(); // b.ts declares no "dep:" lines
	});

	it("PIT_NO_REPO_GRAPH disables deps extraction AND persistence entirely", async () => {
		const cache: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "old-sha",
			entries: [{ path: "a.ts", symbols: ["aOld"], mtimeMs: 1 }],
		};
		const { deps, depsExtractCounts, saved } = makeDeps({
			head: "new-sha",
			diff: [{ status: "M", path: "a.ts" }],
			cache,
			files: { "a.ts": "aNew\ndep:b.ts" },
			mtimes: { "a.ts": 1 },
			extractDeps: (content) => extractDepLines(content),
		});
		const prev = process.env.PIT_NO_REPO_GRAPH;
		process.env.PIT_NO_REPO_GRAPH = "1";
		try {
			const result = await getLivingRepoMap(CWD, deps);
			expect(depsExtractCounts["a.ts"]).toBeUndefined(); // extractor never invoked
			const byPath = Object.fromEntries(result.map.entries.map((e) => [e.path, e.deps]));
			expect(byPath["a.ts"]).toBeUndefined();
			expect(saved.last?.entries.every((e) => e.deps === undefined)).toBe(true);
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_REPO_GRAPH;
			else process.env.PIT_NO_REPO_GRAPH = prev;
		}
	});

	it("without PIT_NO_REPO_GRAPH, symbols/decls extraction is unaffected either way (parity check)", async () => {
		const { deps: depsOn, parseCounts: parseCountsOn } = makeDeps({
			head: null,
			files: { "a.ts": "aSym" },
			extractDeps: (content) => extractDepLines(content),
		});
		const { deps: depsOff, parseCounts: parseCountsOff } = makeDeps({
			head: null,
			files: { "a.ts": "aSym" },
		});
		const prev = process.env.PIT_NO_REPO_GRAPH;
		process.env.PIT_NO_REPO_GRAPH = "1";
		try {
			const resultOn = await getLivingRepoMap(CWD, depsOn);
			delete process.env.PIT_NO_REPO_GRAPH;
			const resultOff = await getLivingRepoMap(CWD, depsOff);
			expect(resultOn.map.entries.map((e) => e.symbols)).toEqual(resultOff.map.entries.map((e) => e.symbols));
			expect(parseCountsOn["a.ts"]).toBe(1);
			expect(parseCountsOff["a.ts"]).toBe(1);
		} finally {
			if (prev === undefined) delete process.env.PIT_NO_REPO_GRAPH;
			else process.env.PIT_NO_REPO_GRAPH = prev;
		}
	});
});

describe("cache round-trip + digest projection", () => {
	it("saveRepoMapCache/loadRepoMapCache round-trips on real disk", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pit-repomap-"));
		try {
			const cachePath = join(dir, ".pit", "repo-map.jsonl");
			const map: LivingRepoMap = {
				version: 3,
				lastIndexedCommit: "sha123",
				entries: [
					{ path: "a.ts", symbols: ["f", "C"], mtimeMs: 10 },
					{ path: "b.ts", symbols: ["g"], mtimeMs: 20 },
				],
			};
			saveRepoMapCache(cachePath, map);
			const loaded = loadRepoMapCache(cachePath);
			expect(loaded?.lastIndexedCommit).toBe("sha123");
			expect(loaded?.entries).toEqual(map.entries);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loadRepoMapCache returns undefined on a missing file and skips corrupt lines", async () => {
		const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join, dirname } = await import("node:path");
		expect(loadRepoMapCache("/no/such/file.jsonl")).toBeUndefined();

		const dir = mkdtempSync(join(tmpdir(), "pit-repomap-"));
		try {
			const cachePath = join(dir, "c.jsonl");
			mkdirSync(dirname(cachePath), { recursive: true });
			// Valid header, one good line, one garbage line.
			writeFileSync(
				cachePath,
				`${JSON.stringify({ version: 3, lastIndexedCommit: "s" })}\n${JSON.stringify({ path: "ok.ts", symbols: ["x"], mtimeMs: 1 })}\n{not json\n`,
				"utf8",
			);
			const loaded = loadRepoMapCache(cachePath);
			expect(loaded?.entries.map((e) => e.path)).toEqual(["ok.ts"]); // garbage skipped
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("saveRepoMapCache/loadRepoMapCache round-trips the new `deps` field", async () => {
		const { mkdtempSync, rmSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pit-repomap-"));
		try {
			const cachePath = join(dir, ".pit", "repo-map.jsonl");
			const map: LivingRepoMap = {
				version: 3,
				lastIndexedCommit: "sha123",
				entries: [
					{ path: "a.ts", symbols: ["f"], deps: ["b.ts", "c.ts"], mtimeMs: 10 },
					{ path: "b.ts", symbols: ["g"], mtimeMs: 20 }, // no deps -> stays unset
				],
			};
			saveRepoMapCache(cachePath, map);
			const loaded = loadRepoMapCache(cachePath);
			expect(loaded?.entries).toEqual(map.entries);
			expect(loaded?.entries[0]?.deps).toEqual(["b.ts", "c.ts"]);
			expect(loaded?.entries[1]?.deps).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a v2-versioned cache (pre-repo-graph) is invalidated by the v3 bump — full reindex, not a partial read", async () => {
		const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = await import("node:fs");
		const { tmpdir } = await import("node:os");
		const { join, dirname } = await import("node:path");
		const dir = mkdtempSync(join(tmpdir(), "pit-repomap-"));
		try {
			const cachePath = join(dir, ".pit", "repo-map.jsonl");
			mkdirSync(dirname(cachePath), { recursive: true });
			// A well-formed v2 cache (no `deps` field at all — pre-repo-graph shape).
			writeFileSync(
				cachePath,
				`${JSON.stringify({ version: 2, lastIndexedCommit: "old-sha" })}\n${JSON.stringify({ path: "a.ts", symbols: ["x"], mtimeMs: 1 })}\n`,
				"utf8",
			);
			// CACHE_VERSION is now 3 -> the version check rejects it outright.
			expect(loadRepoMapCache(cachePath)).toBeUndefined();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("livingRepoMapToDigests projects to the file-digests Record shape, filtered by path", () => {
		const map: LivingRepoMap = {
			version: 3,
			lastIndexedCommit: "s",
			entries: [
				{ path: "a.ts", symbols: ["f", "C"], mtimeMs: 1 },
				{ path: "b.ts", symbols: ["g"], mtimeMs: 1 },
			],
		};
		const all = livingRepoMapToDigests(map);
		expect(all).toEqual({ "a.ts": "f, C", "b.ts": "g" });
		// Filtered to a subset (compaction's touched paths).
		const subset = livingRepoMapToDigests(map, ["a.ts"]);
		expect(subset).toEqual({ "a.ts": "f, C" });
	});
});
