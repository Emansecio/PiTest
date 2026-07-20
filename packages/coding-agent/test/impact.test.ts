import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getLivingRepoMap = vi.fn();

vi.mock("../src/core/repo-map/living-index.ts", () => ({
	getLivingRepoMap: (...args: unknown[]) => getLivingRepoMap(...args),
}));

import { createImpactTool } from "../src/core/tools/impact.ts";

const cwd = process.cwd();

/** One RepoMapEntry fixture; `deps` omitted entirely when absent (mirrors a v2/PIT_NO_REPO_GRAPH cache). */
function entry(path: string, symbols: string[] = ["x"], deps?: string[]): Record<string, unknown> {
	return { path, symbols, mtimeMs: 1, ...(deps ? { deps } : {}) };
}

function mockMap(entries: Array<Record<string, unknown>>): void {
	getLivingRepoMap.mockResolvedValue({
		map: { version: 4, lastIndexedCommit: "abc", entries },
		mode: "cache-hit",
		reindexedCount: 0,
	});
}

function textOf(result: any): string {
	return (result?.content ?? []).map((c: any) => c.text ?? "").join("");
}

describe("impact tool", () => {
	beforeEach(() => {
		getLivingRepoMap.mockReset();
	});

	describe("by path — dependents", () => {
		it("groups dependents by hop distance, default depth 2", async () => {
			mockMap([
				entry("src/seed.ts"),
				entry("src/a.ts", ["x"], ["src/seed.ts"]),
				entry("src/b.ts", ["x"], ["src/seed.ts"]),
				entry("src/c.ts", ["x"], ["src/a.ts"]), // 2 hops from seed
			]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { path: "src/seed.ts" }, undefined, undefined, undefined as never);
			const text = textOf(res);
			expect(text).toContain("Dependents of src/seed.ts (depth <=2): direct: src/a.ts, src/b.ts · 2 hops: src/c.ts");
			expect(text).toContain("(from the persisted import graph — heuristic; use lsp references for authority)");
		});

		it("reports none found for a file with zero dependents", async () => {
			mockMap([entry("src/lonely.ts")]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { path: "src/lonely.ts" }, undefined, undefined, undefined as never);
			expect(textOf(res)).toContain("Dependents of src/lonely.ts: none found.");
		});

		it("clamps depth to the cap of 4", async () => {
			// Chain: a<-b<-c<-d<-e (each imports the previous), 5 hops from seed.
			mockMap([
				entry("src/seed.ts"),
				entry("src/a.ts", ["x"], ["src/seed.ts"]),
				entry("src/b.ts", ["x"], ["src/a.ts"]),
				entry("src/c.ts", ["x"], ["src/b.ts"]),
				entry("src/d.ts", ["x"], ["src/c.ts"]),
				entry("src/e.ts", ["x"], ["src/d.ts"]), // distance 5 — must be excluded
			]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute(
				"t",
				{ path: "src/seed.ts", depth: 10 },
				undefined,
				undefined,
				undefined as never,
			);
			const text = textOf(res);
			expect(text).toContain("depth <=4");
			expect(text).toContain("src/d.ts");
			expect(text).not.toContain("src/e.ts");
		});

		it("caps the display at ~40 paths and folds the rest into +N more", async () => {
			const dependents = Array.from({ length: 45 }, (_, i) => `src/dep${i}.ts`);
			mockMap([entry("src/hub.ts"), ...dependents.map((p) => entry(p, ["x"], ["src/hub.ts"]))]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { path: "src/hub.ts" }, undefined, undefined, undefined as never);
			const text = textOf(res);
			expect(text).toContain("+5 more");
		});

		it("resolves an absolute path the same as the equivalent repo-relative one", async () => {
			mockMap([entry("src/seed.ts"), entry("src/a.ts", ["x"], ["src/seed.ts"])]);
			const tool = createImpactTool(cwd);
			const relRes = await tool.execute("t", { path: "src/seed.ts" }, undefined, undefined, undefined as never);
			const absRes = await tool.execute(
				"t",
				{ path: join(cwd, "src", "seed.ts") },
				undefined,
				undefined,
				undefined as never,
			);
			expect(textOf(absRes)).toBe(textOf(relRes));
		});
	});

	describe("by path — dependencies / both", () => {
		it("lists only DIRECT dependencies", async () => {
			mockMap([
				entry("src/seed.ts", ["x"], ["src/dep1.ts", "src/dep2.ts"]),
				entry("src/dep1.ts"),
				entry("src/dep2.ts", ["x"], ["src/dep1.ts"]), // dep2's own dependency (dep1) must not surface
			]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute(
				"t",
				{ path: "src/seed.ts", direction: "dependencies" },
				undefined,
				undefined,
				undefined as never,
			);
			const text = textOf(res);
			expect(text).toContain("Dependencies of src/seed.ts (direct only): src/dep1.ts, src/dep2.ts");
			expect(text).not.toContain("Dependents of");
		});

		it("'both' renders dependents AND dependencies sections", async () => {
			mockMap([
				entry("src/seed.ts", ["x"], ["src/dep1.ts"]),
				entry("src/dep1.ts"),
				entry("src/a.ts", ["x"], ["src/seed.ts"]),
			]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute(
				"t",
				{ path: "src/seed.ts", direction: "both" },
				undefined,
				undefined,
				undefined as never,
			);
			const text = textOf(res);
			expect(text).toContain("Dependents of src/seed.ts");
			expect(text).toContain("Dependencies of src/seed.ts");
		});
	});

	describe("by symbol", () => {
		it("locates a single declaration and queries its dependents", async () => {
			mockMap([entry("src/foo.ts", ["Foo"]), entry("src/bar.ts", ["Bar"], ["src/foo.ts"])]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { symbol: "Foo" }, undefined, undefined, undefined as never);
			const text = textOf(res);
			expect(text).toContain('symbol "Foo" (declared in src/foo.ts)');
			expect(text).toContain("src/bar.ts");
		});

		it("falls back to a case-insensitive match when no exact match exists", async () => {
			mockMap([entry("src/foo.ts", ["fooBar"])]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { symbol: "FOOBAR" }, undefined, undefined, undefined as never);
			expect(textOf(res)).toContain("src/foo.ts");
		});

		it("multiple declarations: displays up to 5 and uses ALL as seeds", async () => {
			const files = Array.from({ length: 7 }, (_, i) => `src/dup${i}.ts`);
			mockMap([
				...files.map((f, i) => (i === 6 ? entry(f, ["Dup"], ["src/shared-dep.ts"]) : entry(f, ["Dup"]))),
				entry("src/shared-dep.ts"),
			]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute(
				"t",
				{ symbol: "Dup", direction: "dependencies" },
				undefined,
				undefined,
				undefined as never,
			);
			const text = textOf(res);
			expect(text).toContain("declared in src/dup0.ts, src/dup1.ts, src/dup2.ts, src/dup3.ts, src/dup4.ts, +2 more");
			// dup6.ts (beyond the display cap) was still used as a seed: its own
			// dependency surfaces in the dependencies section.
			expect(text).toContain("src/shared-dep.ts");
		});

		it("returns a helpful message for a symbol that doesn't exist", async () => {
			mockMap([entry("src/foo.ts", ["Foo"])]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { symbol: "DoesNotExist" }, undefined, undefined, undefined as never);
			const text = textOf(res).toLowerCase();
			expect(text).toContain("no declaration");
			expect(text).toContain("find_symbol");
		});

		it("zero-match adds the symbol-index cap note; a successful match does not (Fase 4B)", async () => {
			mockMap([entry("src/foo.ts", ["Foo"])]);
			const tool = createImpactTool(cwd);

			const miss = await tool.execute("t", { symbol: "DoesNotExist" }, undefined, undefined, undefined as never);
			expect(textOf(miss)).toContain(
				"(the symbol index keeps at most 12 top-level symbols per file — for deep files use find_symbol or lsp)",
			);

			const hit = await tool.execute("t", { symbol: "Foo" }, undefined, undefined, undefined as never);
			expect(textOf(hit)).not.toContain("symbol index keeps at most");
		});
	});

	describe("tests covering (Fase 4B)", () => {
		it("lists test-shaped direct dependents of the seed", async () => {
			mockMap([
				entry("src/seed.ts"),
				entry("src/a.ts", ["x"], ["src/seed.ts"]),
				entry("test/seed.test.ts", ["x"], ["src/seed.ts"]),
				entry("src/seed.spec.ts", ["x"], ["src/seed.ts"]),
			]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { path: "src/seed.ts" }, undefined, undefined, undefined as never);
			expect(textOf(res)).toContain("Tests covering src/seed.ts: src/seed.spec.ts, test/seed.test.ts");
		});

		it("reports none found (by naming convention) when no dependent is a test", async () => {
			mockMap([entry("src/seed.ts"), entry("src/a.ts", ["x"], ["src/seed.ts"])]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { path: "src/seed.ts" }, undefined, undefined, undefined as never);
			expect(textOf(res)).toContain("Tests covering src/seed.ts: none found (by naming convention).");
		});

		it("caps the tests list at 10 and folds the rest into +N more", async () => {
			const tests = Array.from({ length: 12 }, (_, i) => `test/dep${String(i).padStart(2, "0")}.test.ts`);
			mockMap([entry("src/seed.ts"), ...tests.map((p) => entry(p, ["x"], ["src/seed.ts"]))]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { path: "src/seed.ts" }, undefined, undefined, undefined as never);
			// Assert on the tests line alone — the Dependents section above it lists
			// the same files under its own (larger) display cap.
			const testsLine = textOf(res)
				.split("\n")
				.find((l) => l.startsWith("Tests covering"));
			expect(testsLine).toContain("(+2 more)");
			expect(testsLine).toContain("test/dep09.test.ts");
			expect(testsLine).not.toContain("test/dep10.test.ts");
		});

		it("unions covering tests across every declaring file of a symbol", async () => {
			mockMap([
				entry("src/a.ts", ["Dup"]),
				entry("src/b.ts", ["Dup"]),
				entry("test/a.test.ts", ["x"], ["src/a.ts"]),
				entry("test/b.test.ts", ["x"], ["src/b.ts"]),
			]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { symbol: "Dup" }, undefined, undefined, undefined as never);
			expect(textOf(res)).toContain("test/a.test.ts, test/b.test.ts");
		});
	});

	describe("argument validation", () => {
		it("errors when neither path nor symbol is given", async () => {
			mockMap([entry("src/foo.ts")]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", {}, undefined, undefined, undefined as never);
			expect((res as { isError?: boolean }).isError).toBe(true);
			expect(textOf(res)).toContain("Provide either");
		});

		it("errors when both path and symbol are given", async () => {
			mockMap([entry("src/foo.ts")]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute(
				"t",
				{ path: "src/foo.ts", symbol: "Foo" },
				undefined,
				undefined,
				undefined as never,
			);
			expect((res as { isError?: boolean }).isError).toBe(true);
			expect(textOf(res)).toContain("exactly one");
		});
	});

	describe("empty map", () => {
		it("degrades to 'none found' without throwing", async () => {
			mockMap([]);
			const tool = createImpactTool(cwd);
			const res = await tool.execute("t", { path: "src/anything.ts" }, undefined, undefined, undefined as never);
			expect(textOf(res)).toContain("none found");
		});
	});
});
