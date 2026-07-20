/**
 * Repo Graph — query layer over `RepoMapEntry[]`.
 *
 * `edges.ts` resolves per-file import edges; `living-index.ts` persists them onto
 * `RepoMapEntry.deps`. This module turns that flat entry list into an actually
 * queryable graph: a forward index (deps) and a reverse index (dependents), plus
 * `blastRadius` — "if I change this file, what else might break" — the whole
 * point of tracking edges in the first place (a caller grounding a risky edit
 * against its transitive dependents, not just its symbols).
 *
 * Pure: takes `RepoMapEntry[]` in, has no I/O of its own. Deterministic: every
 * traversal result is sorted so two callers building the same graph from the same
 * entries always get byte-identical output (load-bearing for tests AND for a
 * caller diffing "did the blast radius change").
 */

import type { RepoMapEntry } from "./living-index.ts";

/** Forward + reverse adjacency built once from `RepoMapEntry[]`. */
export interface RepoGraph {
	/** path -> repo-relative paths it imports (as persisted on the entry). */
	deps: Map<string, string[]>;
	/** path -> repo-relative paths that import IT (the reverse index), sorted. */
	dependents: Map<string, string[]>;
}

/** One file reached by `blastRadius`, with its BFS hop distance from the nearest seed. */
export interface BlastRadiusEntry {
	path: string;
	/** Hop count from the nearest seed via the dependents edge (1 = direct dependent). */
	distance: number;
}

export interface BlastRadiusResult {
	/** Reached files, seeds excluded, sorted by (distance, path) ascending. */
	files: BlastRadiusEntry[];
	/** True when `maxNodes` cut off further results (more dependents existed but were not returned). */
	capped: boolean;
}

export interface BlastRadiusOptions {
	/** Max BFS hops to traverse. Default 2. */
	maxDepth?: number;
	/** Hard cap on the number of files returned. Default 200. */
	maxNodes?: number;
}

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_NODES = 200;

/**
 * Build the forward (`deps`) and reverse (`dependents`) adjacency maps from a
 * `RepoMapEntry[]` snapshot. Entries without `deps` (PIT_NO_REPO_GRAPH, or a
 * language/file the extractor doesn't cover) simply contribute no edges — the
 * graph degrades to all-nodes-no-edges, never throws.
 */
export function buildRepoGraph(entries: RepoMapEntry[]): RepoGraph {
	const deps = new Map<string, string[]>();
	const dependents = new Map<string, string[]>();
	for (const entry of entries) {
		const list = entry.deps ?? [];
		deps.set(entry.path, list);
		for (const target of list) {
			const existing = dependents.get(target);
			if (existing) existing.push(entry.path);
			else dependents.set(target, [entry.path]);
		}
	}
	// Sorted once here (not per-query) so every consumer of `dependents` — direct
	// lookups AND blastRadius's BFS frontier — sees a deterministic order for free.
	for (const list of dependents.values()) list.sort();
	return { deps, dependents };
}

/** Files `path` imports (its persisted `deps`, or [] if untracked). */
export function dependenciesOf(graph: RepoGraph, path: string): string[] {
	return graph.deps.get(path) ?? [];
}

/** Files that import `path` (the reverse index, or [] if nothing does). */
export function dependentsOf(graph: RepoGraph, path: string): string[] {
	return graph.dependents.get(path) ?? [];
}

/**
 * BFS over the REVERSE (dependents) edge from `seeds`: "what depends on these
 * files, transitively, up to `maxDepth` hops". Seeds themselves are excluded from
 * the result. Cycle-safe (a `visited` set means every node is discovered at most
 * once, at its FIRST/shortest distance) and deterministic — each BFS level is
 * sorted alphabetically before being appended, independent of `entries` input
 * order or seed order.
 *
 * `capped` signals the hard `maxNodes` cap cut off real results (more dependents
 * existed beyond it); it does NOT fire for `maxDepth` alone reaching its limit —
 * that is the caller's own bound, not an unexpected truncation.
 */
export function blastRadius(graph: RepoGraph, seeds: string[], opts?: BlastRadiusOptions): BlastRadiusResult {
	const maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
	const maxNodes = opts?.maxNodes ?? DEFAULT_MAX_NODES;

	const visited = new Map<string, number>();
	const uniqueSeeds = Array.from(new Set(seeds));
	for (const seed of uniqueSeeds) visited.set(seed, 0);

	const order: string[] = [];
	let capped = false;
	let frontier = uniqueSeeds;
	let depth = 0;

	while (frontier.length > 0 && depth < maxDepth && !capped) {
		depth++;
		const nextSet = new Set<string>();
		for (const node of frontier) {
			for (const dependent of dependentsOf(graph, node)) {
				if (!visited.has(dependent)) nextSet.add(dependent);
			}
		}
		const next = Array.from(nextSet).sort();
		for (const path of next) {
			if (order.length >= maxNodes) {
				capped = true;
				break;
			}
			visited.set(path, depth);
			order.push(path);
		}
		frontier = next;
	}

	const files: BlastRadiusEntry[] = order.map((path) => ({ path, distance: visited.get(path) ?? depth }));
	return { files, capped };
}
