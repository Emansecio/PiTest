/**
 * Built-in graph-prefetch extension — P6 (`docs/proposals/2026-07-22-propostas-fronteira.md`,
 * "P6 — Prefetch preditivo pelo grafo de código"). Same mold as `impact-extension.ts`:
 * a `pi.on("tool_result")` handler over the Living Repo Map's import graph
 * (`getLivingRepoMap` + `buildRepoGraph`), but forward-looking instead of
 * advisory. Where impact-extension answers "what does THIS edit put at risk"
 * after a mutation, this extension answers "what is the model LIKELY to read
 * next" after a navigation call — and warms it ahead of time.
 *
 * Design:
 *  - Trigger: a successful `read` / `symbol` / `find_symbol` result names one or
 *    more files (`read`/`symbol` via their `path` argument; `find_symbol` via its
 *    own deterministic `"<relPath>:<line>"` output lines — see `find-symbol.ts` —
 *    since it takes a symbol NAME, not a path, capped to the first few hits).
 *  - Neighbors: grade-1 graph neighbors of each seed, priority `dependentsOf` >
 *    `dependenciesOf` > `testsCovering` (files that import the seed are the most
 *    likely next read — e.g. "who calls this function" — ahead of what the seed
 *    itself imports, ahead of its test coverage). Deduplicated across seeds and
 *    across the whole turn, capped at a shared per-turn budget.
 *  - Warming: each selected neighbor is stat'd + read (utf-8) and stored into a
 *    `WarmFileCache` keyed by absolute path with `(mtimeMs, size)` recorded at
 *    warm time. `read.ts` consults this cache before its own `ops.readFile`,
 *    with a hit conditioned on the LIVE stat matching that pair exactly — a
 *    stale prefetch (file changed after warming, before the model reads it) is
 *    therefore never served; it only wasted the prefetch, never correctness.
 *  - Zero tokens: nothing here ever touches the tool result or the model's
 *    context. Warming is fire-and-forget (the `tool_result` handler never
 *    awaits it) so it can add no latency to the result the model is waiting on.
 *  - Backpressure: warming pauses (queues no NEW file read) while a mutating
 *    tool (`stagnation.ts`'s `MUTATING_TOOL_NAMES`) is in flight — a file the
 *    session might be actively rewriting is exactly the wrong moment to race a
 *    disk read against.
 *  - Fail-open by construction: any error building the graph, resolving a path,
 *    statting, or reading a neighbor degrades to "skip this one file" — it can
 *    never affect the read/symbol/find_symbol result the model actually asked
 *    for. Kill-switch `PIT_NO_GRAPH_PREFETCH` disables registration entirely.
 *    With `PIT_NO_REPO_GRAPH` the Living Repo Map carries no `deps` at all, so
 *    `buildRepoGraph` yields an edge-less graph and every neighbor lookup
 *    returns nothing — this extension degrades to a no-op on its own.
 *
 * Graph access mirrors `impact-extension.ts`'s `getCachedGraph`: the same
 * `getLivingRepoMap(cwd)` call, memoized behind a short TTL (closure-scoped per
 * extension instance) so a burst of navigation calls in one turn doesn't
 * re-read + re-diff the map per call.
 */

import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { relative } from "node:path";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import type { ExtensionAPI } from "../extensions/index.js";
import { buildRepoGraph, dependenciesOf, dependentsOf, type RepoGraph, testsCovering } from "../repo-map/graph.ts";
import { getLivingRepoMap } from "../repo-map/living-index.ts";
import { MUTATING_TOOL_NAMES } from "../stagnation.ts";
import { extractPathArg, resolveToolPath } from "../tools/argument-prep.ts";
import type { WarmFileCache } from "../tools/warm-file-cache.ts";

/** How long the built `RepoGraph` is reused before re-reading the living map (mirrors impact-extension's graphCache). */
const GRAPH_CACHE_TTL_MS = 5000;
/**
 * Shared budget of actual disk reads across every seed for the whole turn — a
 * neighbor already resident in the cache (a cheap membership check) does not
 * spend it, only a real `readFileSnapshot` attempt does.
 */
const NEIGHBOR_BUDGET_PER_TURN = 12;
/**
 * Skip warming a single candidate above this size. The prefetcher is a small
 * speculative warm-up, not a general cache — a huge file is cheap enough for
 * the model's own `read` to page through on demand, and reading it here would
 * eat a disproportionate share of the byte budget for a file that may never
 * actually be read.
 */
const MAX_WARM_FILE_BYTES = 512 * 1024;
/** find_symbol can return up to 30 hits; only the first few seed prefetch (the model almost always wants the first match). */
const FIND_SYMBOL_SEED_CAP = 5;

export function isGraphPrefetchDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return isTruthyEnvFlag(env.PIT_NO_GRAPH_PREFETCH);
}

/** One successfully-read candidate, ready to store in the {@link WarmFileCache}. */
export interface FileReadSnapshot {
	content: string;
	mtimeMs: number;
	size: number;
}

async function defaultReadFileSnapshot(absPath: string): Promise<FileReadSnapshot | undefined> {
	try {
		const st = await fsStat(absPath);
		if (!st.isFile() || st.size > MAX_WARM_FILE_BYTES) return undefined;
		const content = await fsReadFile(absPath, "utf-8");
		return { content, mtimeMs: st.mtimeMs, size: st.size };
	} catch {
		return undefined;
	}
}

/** Repo-relative, forward-slash path — same convention as `RepoMapEntry.path` (see `impact-extension.ts`'s twin helper). */
function toRepoRelPath(cwd: string, absPath: string): string {
	return relative(cwd, absPath).split("\\").join("/");
}

/**
 * find_symbol's own deterministic output line shape is `"<relPath>:<line>"`
 * (native path separators — see `find-symbol.ts`). Extracts up to
 * `FIND_SYMBOL_SEED_CAP` distinct, forward-slash-normalized paths in
 * appearance order. Returns `[]` for the "No declaration ..." not-found line
 * (it never matches the pattern), which is exactly the right outcome — nothing
 * to seed from.
 */
function extractFindSymbolSeeds(text: string): string[] {
	const seeds: string[] = [];
	const seen = new Set<string>();
	for (const rawLine of text.split("\n")) {
		const match = /^(.+):(\d+)$/.exec(rawLine.trim());
		if (!match) continue;
		const path = match[1].split("\\").join("/");
		if (seen.has(path)) continue;
		seen.add(path);
		seeds.push(path);
		if (seeds.length >= FIND_SYMBOL_SEED_CAP) break;
	}
	return seeds;
}

function textOfContent(content: readonly { type: string; text?: string }[]): string {
	return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

export interface GraphPrefetchOptions {
	cwd: string;
	/**
	 * Lazily-resolved accessor for the session's `WarmFileCache` (mirrors
	 * `getReadDedupeStore` in `built-ins/index.ts` — the session, and its cache,
	 * don't exist yet when extensions are bundled). Undefined, or a call that
	 * returns undefined, disables warming entirely: there's nothing to warm into.
	 */
	getWarmFileCache?: () => WarmFileCache | undefined;
	/**
	 * Injected for tests so warming never touches the real filesystem. Defaults
	 * to `fs/promises` stat+readFile. Returns undefined for a missing file, a
	 * directory, an oversized candidate, or any read error — every one of those
	 * is "skip this file" to the caller.
	 */
	readFileSnapshot?: (absPath: string) => Promise<FileReadSnapshot | undefined>;
}

export function createGraphPrefetchExtension(options: GraphPrefetchOptions) {
	return (pi: ExtensionAPI) => {
		if (isGraphPrefetchDisabled()) return;
		const readFileSnapshot = options.readFileSnapshot ?? defaultReadFileSnapshot;

		let graphCache: { at: number; graph: RepoGraph } | undefined;
		const getCachedGraph = async (): Promise<RepoGraph> => {
			const now = Date.now();
			if (graphCache && now - graphCache.at < GRAPH_CACHE_TTL_MS) return graphCache.graph;
			const { map } = await getLivingRepoMap(options.cwd);
			const graph = buildRepoGraph(map.entries);
			graphCache = { at: now, graph };
			return graph;
		};

		// Per-turn bookkeeping: one shared budget across every seed this turn,
		// plus a dedupe set so two different seeds never double-queue the same
		// neighbor. Reset on turn_start — mirrors impact-extension's per-turn reset.
		let budgetRemaining = NEIGHBOR_BUDGET_PER_TURN;
		let queuedThisTurn = new Set<string>();
		// Counts overlapping mutating tool executions (parallel tool rounds can run
		// more than one at once) — warming pauses (queues no NEW read) while this
		// is above zero.
		let mutatingInFlight = 0;

		pi.on("turn_start", () => {
			budgetRemaining = NEIGHBOR_BUDGET_PER_TURN;
			queuedThisTurn = new Set();
		});

		pi.on("tool_execution_start", (event) => {
			if (MUTATING_TOOL_NAMES.has(event.toolName)) mutatingInFlight++;
		});
		pi.on("tool_execution_end", (event) => {
			if (MUTATING_TOOL_NAMES.has(event.toolName)) mutatingInFlight = Math.max(0, mutatingInFlight - 1);
		});

		const warmNeighbors = async (cache: WarmFileCache, seeds: readonly string[]): Promise<void> => {
			try {
				const graph = await getCachedGraph();
				const candidates: string[] = [];
				const localSeen = new Set<string>();
				for (const seed of seeds) {
					// Priority per seed: dependentsOf > dependenciesOf > testsCovering.
					// The shared budget below still caps the aggregate across every
					// seed/priority combined, so an early seed's dependents can't starve
					// a later seed entirely, but always go first.
					for (const group of [
						dependentsOf(graph, seed),
						dependenciesOf(graph, seed),
						testsCovering(graph, seed),
					]) {
						for (const path of group) {
							if (localSeen.has(path) || queuedThisTurn.has(path)) continue;
							localSeen.add(path);
							candidates.push(path);
						}
					}
				}
				for (const relPath of candidates) {
					if (budgetRemaining <= 0) return;
					if (mutatingInFlight > 0) return;
					const absPath = resolveToolPath(relPath, options.cwd);
					if (cache.has(absPath)) {
						// Already warm — a cheap membership check, not real disk I/O, so it
						// doesn't spend the scarce read budget. Without this, a handful of
						// hub files re-discovered every turn could starve every OTHER
						// neighbor of ever getting its first warm.
						queuedThisTurn.add(relPath);
						continue;
					}
					queuedThisTurn.add(relPath);
					budgetRemaining--;
					const snapshot = await readFileSnapshot(absPath);
					if (!snapshot) continue;
					if (mutatingInFlight > 0) continue; // a mutation started mid-read; drop this one rather than warm possibly-stale content
					cache.set(absPath, snapshot);
				}
			} catch {
				// Best-effort warming; never surfaces to the model or the session.
			}
		};

		pi.on("tool_result", (event) => {
			try {
				if (isGraphPrefetchDisabled()) return undefined;
				if (event.isError) return undefined;
				if (event.toolName !== "read" && event.toolName !== "symbol" && event.toolName !== "find_symbol") {
					return undefined;
				}
				if (budgetRemaining <= 0) return undefined;
				const cache = options.getWarmFileCache?.();
				if (!cache) return undefined;

				let seeds: string[];
				if (event.toolName === "find_symbol") {
					seeds = extractFindSymbolSeeds(textOfContent(event.content));
				} else {
					const rawPath = extractPathArg(event.input);
					if (!rawPath) return undefined;
					const absSeed = resolveToolPath(rawPath, options.cwd);
					seeds = [toRepoRelPath(options.cwd, absSeed)];
				}
				if (seeds.length === 0) return undefined;

				// Fire-and-forget: never await this from the handler — warming must
				// never add latency to the read/symbol/find_symbol result the model
				// is waiting on.
				void warmNeighbors(cache, seeds);
			} catch {
				// Seed extraction is best-effort; never let it affect the tool result.
			}
			return undefined;
		});
	};
}
