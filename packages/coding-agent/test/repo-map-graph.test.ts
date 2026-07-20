import { describe, expect, it } from "vitest";
import {
	blastRadius,
	buildRepoGraph,
	dependenciesOf,
	dependentsOf,
	isTestPath,
	testsCovering,
} from "../src/core/repo-map/graph.js";
import type { RepoMapEntry } from "../src/core/repo-map/living-index.js";

function entry(path: string, deps: string[] = []): RepoMapEntry {
	return { path, symbols: [], deps, mtimeMs: 1 };
}

describe("buildRepoGraph", () => {
	it("builds forward and reverse adjacency", () => {
		const entries = [entry("a.ts", ["b.ts"]), entry("b.ts", ["c.ts"]), entry("c.ts", [])];
		const graph = buildRepoGraph(entries);
		expect(dependenciesOf(graph, "a.ts")).toEqual(["b.ts"]);
		expect(dependentsOf(graph, "b.ts")).toEqual(["a.ts"]);
		expect(dependentsOf(graph, "c.ts")).toEqual(["b.ts"]);
		expect(dependentsOf(graph, "a.ts")).toEqual([]); // nothing depends on a.ts
	});

	it("treats a missing `deps` field as no edges (PIT_NO_REPO_GRAPH degradation)", () => {
		const entries: RepoMapEntry[] = [{ path: "a.ts", symbols: [], mtimeMs: 1 }];
		const graph = buildRepoGraph(entries);
		expect(dependenciesOf(graph, "a.ts")).toEqual([]);
		expect(graph.dependents.size).toBe(0);
	});

	it("sorts multiple dependents of the same file deterministically", () => {
		const entries = [entry("z.ts", ["shared.ts"]), entry("a.ts", ["shared.ts"]), entry("m.ts", ["shared.ts"])];
		const graph = buildRepoGraph(entries);
		expect(dependentsOf(graph, "shared.ts")).toEqual(["a.ts", "m.ts", "z.ts"]);
	});
});

describe("dependenciesOf / dependentsOf", () => {
	it("returns [] for an untracked path", () => {
		const graph = buildRepoGraph([entry("a.ts", ["b.ts"])]);
		expect(dependenciesOf(graph, "nope.ts")).toEqual([]);
		expect(dependentsOf(graph, "nope.ts")).toEqual([]);
	});
});

describe("blastRadius", () => {
	it("finds direct dependents at distance 1", () => {
		const entries = [entry("a.ts", ["target.ts"]), entry("b.ts", ["target.ts"]), entry("target.ts", [])];
		const graph = buildRepoGraph(entries);
		const result = blastRadius(graph, ["target.ts"]);
		expect(result.capped).toBe(false);
		expect(result.files).toEqual([
			{ path: "a.ts", distance: 1 },
			{ path: "b.ts", distance: 1 },
		]);
	});

	it("excludes the seeds themselves from the result", () => {
		const entries = [entry("a.ts", ["target.ts"]), entry("target.ts", [])];
		const graph = buildRepoGraph(entries);
		const result = blastRadius(graph, ["target.ts", "a.ts"]);
		// target.ts and a.ts are both seeds -> neither appears even though a.ts
		// is also a direct dependent of target.ts.
		expect(result.files).toEqual([]);
	});

	it("walks multiple hops up to maxDepth, tagging each with its own distance", () => {
		// c -> b -> a -> target  (c depends on b, b depends on a, a depends on target)
		const entries = [
			entry("target.ts", []),
			entry("a.ts", ["target.ts"]),
			entry("b.ts", ["a.ts"]),
			entry("c.ts", ["b.ts"]),
		];
		const graph = buildRepoGraph(entries);
		const result = blastRadius(graph, ["target.ts"], { maxDepth: 3 });
		expect(result.files).toEqual([
			{ path: "a.ts", distance: 1 },
			{ path: "b.ts", distance: 2 },
			{ path: "c.ts", distance: 3 },
		]);
	});

	it("stops at the default maxDepth (2) without reaching further hops", () => {
		const entries = [
			entry("target.ts", []),
			entry("a.ts", ["target.ts"]),
			entry("b.ts", ["a.ts"]),
			entry("c.ts", ["b.ts"]),
		];
		const graph = buildRepoGraph(entries);
		const result = blastRadius(graph, ["target.ts"]);
		expect(result.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
		expect(result.capped).toBe(false); // depth bound is not "capped" truncation
	});

	it("is cycle-safe: a dependency cycle never loops or double-counts", () => {
		// a -> b -> a (cycle), both depend on target too.
		const entries = [entry("target.ts", []), entry("a.ts", ["target.ts", "b.ts"]), entry("b.ts", ["a.ts"])];
		const graph = buildRepoGraph(entries);
		const result = blastRadius(graph, ["target.ts"], { maxDepth: 5 });
		expect(result.files).toEqual([
			{ path: "a.ts", distance: 1 },
			{ path: "b.ts", distance: 2 },
		]);
	});

	it("caps the result at maxNodes and reports capped=true", () => {
		const entries = [entry("target.ts", [])];
		for (let i = 0; i < 10; i++) entries.push(entry(`f${i}.ts`, ["target.ts"]));
		const graph = buildRepoGraph(entries);
		const result = blastRadius(graph, ["target.ts"], { maxNodes: 3 });
		expect(result.files).toHaveLength(3);
		expect(result.capped).toBe(true);
		// Deterministic: alphabetically-first 3 of f0..f9.
		expect(result.files.map((f) => f.path)).toEqual(["f0.ts", "f1.ts", "f2.ts"]);
	});

	it("is deterministic regardless of input entry order or seed order", () => {
		const entriesA = [entry("a.ts", ["target.ts"]), entry("b.ts", ["target.ts"]), entry("target.ts", [])];
		const entriesB = [entry("target.ts", []), entry("b.ts", ["target.ts"]), entry("a.ts", ["target.ts"])];
		const r1 = blastRadius(buildRepoGraph(entriesA), ["target.ts"]);
		const r2 = blastRadius(buildRepoGraph(entriesB), ["target.ts"]);
		expect(r1).toEqual(r2);
	});

	it("returns empty for a seed with no dependents", () => {
		const graph = buildRepoGraph([entry("lonely.ts", [])]);
		const result = blastRadius(graph, ["lonely.ts"]);
		expect(result).toEqual({ files: [], capped: false });
	});

	it("returns empty for a seed not present in the graph at all", () => {
		const graph = buildRepoGraph([entry("a.ts", [])]);
		const result = blastRadius(graph, ["ghost.ts"]);
		expect(result).toEqual({ files: [], capped: false });
	});
});

describe("isTestPath", () => {
	it("matches .test. / .spec. basenames", () => {
		expect(isTestPath("src/foo.test.ts")).toBe(true);
		expect(isTestPath("src/foo.spec.tsx")).toBe(true);
		expect(isTestPath("foo.test.js")).toBe(true);
	});

	it("matches test/, tests/ and __tests__/ directory segments", () => {
		expect(isTestPath("test/foo.ts")).toBe(true);
		expect(isTestPath("packages/x/tests/foo.ts")).toBe(true);
		expect(isTestPath("src/__tests__/foo.ts")).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isTestPath("src/Foo.TEST.ts")).toBe(true);
		expect(isTestPath("TESTS/foo.ts")).toBe(true);
		expect(isTestPath("src/Foo.Spec.ts")).toBe(true);
	});

	it("normalizes backslash separators before segment matching", () => {
		expect(isTestPath("test\\foo.ts")).toBe(true);
		expect(isTestPath("src\\attest\\foo.ts")).toBe(false);
	});

	it("does NOT match mere substrings — segment/basename boundaries only", () => {
		expect(isTestPath("src/contest.ts")).toBe(false); // "test" inside a word
		expect(isTestPath("src/attest/foo.ts")).toBe(false); // "test" inside a segment
		expect(isTestPath("src/protest/foo.ts")).toBe(false);
		expect(isTestPath("src/latest.ts")).toBe(false);
		expect(isTestPath("src/testfoo.ts")).toBe(false); // no ".test." marker, not a "test" segment
		expect(isTestPath("src/test-utils/foo.ts")).toBe(false); // "test-utils" is not the "test" segment
		expect(isTestPath("src/foo.ts")).toBe(false);
	});
});

describe("testsCovering", () => {
	it("filters dependents down to test-shaped paths, sorted", () => {
		const entries = [
			entry("src/foo.ts", []),
			entry("src/consumer.ts", ["src/foo.ts"]),
			entry("test/z-foo.test.ts", ["src/foo.ts"]),
			entry("src/foo.spec.ts", ["src/foo.ts"]),
		];
		const graph = buildRepoGraph(entries);
		expect(testsCovering(graph, "src/foo.ts")).toEqual(["src/foo.spec.ts", "test/z-foo.test.ts"]);
	});

	it("returns [] when no dependents are tests, or the path is untracked", () => {
		const graph = buildRepoGraph([entry("src/foo.ts", []), entry("src/bar.ts", ["src/foo.ts"])]);
		expect(testsCovering(graph, "src/foo.ts")).toEqual([]);
		expect(testsCovering(graph, "ghost.ts")).toEqual([]);
	});
});
