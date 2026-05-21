import { describe, expect, it } from "vitest";
import { extractToolFileOp } from "../src/core/compaction/utils.js";
import { FrequentFilesTracker, formatFrequentFilesForPrompt } from "../src/core/frequent-files.js";

describe("FrequentFilesTracker.record", () => {
	it("counts read/edit/write per file independently", () => {
		const t = new FrequentFilesTracker();
		t.record("a.ts", "read", 1);
		t.record("a.ts", "read", 2);
		t.record("a.ts", "edit", 3);
		t.record("b.ts", "write", 4);
		const top = t.getTop({ topN: 10, minHits: 1 });
		const a = top.find((s) => s.path === "a.ts");
		const b = top.find((s) => s.path === "b.ts");
		expect(a).toMatchObject({ readCount: 2, editCount: 1, writeCount: 0, hits: 3 });
		expect(b).toMatchObject({ readCount: 0, editCount: 0, writeCount: 1, hits: 1 });
	});

	it("ignores empty paths", () => {
		const t = new FrequentFilesTracker();
		t.record("", "read");
		expect(t.size()).toBe(0);
	});

	it("updates lastTouchedAt to the most recent timestamp seen", () => {
		const t = new FrequentFilesTracker();
		t.record("a.ts", "read", 100);
		t.record("a.ts", "read", 200);
		t.record("a.ts", "read", 50); // older — should not regress
		expect(t.getTop({ minHits: 1 })[0].lastTouchedAt).toBe(200);
	});
});

describe("FrequentFilesTracker.getTop", () => {
	it("sorts by hits desc, then lastTouchedAt desc, then path asc", () => {
		const t = new FrequentFilesTracker();
		t.record("c.ts", "read", 100);
		t.record("c.ts", "read", 110);
		t.record("a.ts", "read", 200);
		t.record("a.ts", "read", 210);
		t.record("b.ts", "read", 300);
		t.record("b.ts", "read", 310);
		const top = t.getTop({ minHits: 1, topN: 10 });
		// a and b and c all tied at 2 hits; b touched most recently, then a, then c.
		expect(top.map((s) => s.path)).toEqual(["b.ts", "a.ts", "c.ts"]);
	});

	it("filters by minHits", () => {
		const t = new FrequentFilesTracker();
		t.record("a.ts", "read");
		t.record("b.ts", "read");
		t.record("b.ts", "read");
		const top = t.getTop({ minHits: 2 });
		expect(top.map((s) => s.path)).toEqual(["b.ts"]);
	});

	it("respects topN cap", () => {
		const t = new FrequentFilesTracker();
		for (let i = 0; i < 5; i++) t.record(`f${i}.ts`, "read");
		expect(t.getTop({ topN: 2, minHits: 1 })).toHaveLength(2);
	});

	it("returns empty for topN<=0", () => {
		const t = new FrequentFilesTracker();
		t.record("a.ts", "read");
		expect(t.getTop({ topN: 0 })).toEqual([]);
		expect(t.getTop({ topN: -3 })).toEqual([]);
	});
});

describe("FrequentFilesTracker eviction", () => {
	it("evicts the coldest entry when over capacity for a new path", () => {
		const t = new FrequentFilesTracker({ maxFiles: 2 });
		t.record("hot.ts", "read", 100);
		t.record("hot.ts", "read", 100);
		t.record("hot.ts", "read", 100);
		t.record("warm.ts", "read", 200);
		t.record("cold.ts", "read", 300); // should evict "warm.ts" (1 hit, older than cold.ts after insert)
		expect(t.size()).toBe(2);
		const paths = t.getTop({ minHits: 1 }).map((s) => s.path);
		expect(paths).toContain("hot.ts");
		expect(paths).toContain("cold.ts");
		expect(paths).not.toContain("warm.ts");
	});

	it("does not evict on update of an existing path", () => {
		const t = new FrequentFilesTracker({ maxFiles: 1 });
		t.record("a.ts", "read");
		t.record("a.ts", "read");
		expect(t.size()).toBe(1);
	});
});

describe("FrequentFilesTracker.merge / reset", () => {
	it("merges hit counts from another tracker", () => {
		const a = new FrequentFilesTracker();
		const b = new FrequentFilesTracker();
		a.record("x.ts", "read", 1);
		b.record("x.ts", "edit", 2);
		b.record("y.ts", "write", 3);
		a.merge(b);
		const xs = a.getTop({ minHits: 1 });
		const x = xs.find((s) => s.path === "x.ts");
		expect(x).toMatchObject({ readCount: 1, editCount: 1, hits: 2, lastTouchedAt: 2 });
		expect(xs.find((s) => s.path === "y.ts")?.writeCount).toBe(1);
	});

	it("reset wipes all entries", () => {
		const t = new FrequentFilesTracker();
		t.record("a.ts", "read");
		t.reset();
		expect(t.size()).toBe(0);
		expect(t.getTop({ minHits: 1 })).toEqual([]);
	});
});

describe("formatFrequentFilesForPrompt", () => {
	it("returns empty string when no entries", () => {
		expect(formatFrequentFilesForPrompt([])).toBe("");
	});

	it("renders an XML-ish section with per-file op breakdown", () => {
		const t = new FrequentFilesTracker();
		t.record("src/a.ts", "read", 1);
		t.record("src/a.ts", "edit", 2);
		const out = formatFrequentFilesForPrompt(t.getTop({ minHits: 1 }));
		expect(out).toContain("<frequent_files>");
		expect(out).toContain("</frequent_files>");
		expect(out).toContain("src/a.ts");
		expect(out).toContain("read×1");
		expect(out).toContain("edit×1");
	});

	it("omits zero-count op suffixes", () => {
		const t = new FrequentFilesTracker();
		t.record("only-read.ts", "read");
		const out = formatFrequentFilesForPrompt(t.getTop({ minHits: 1 }));
		expect(out).toContain("read×1");
		expect(out).not.toContain("edit×");
		expect(out).not.toContain("write×");
	});
});

describe("extractToolFileOp", () => {
	it("maps known file tools to ops", () => {
		expect(extractToolFileOp("read", { path: "a.ts" })).toEqual({ path: "a.ts", op: "read" });
		expect(extractToolFileOp("edit", { path: "a.ts" })).toEqual({ path: "a.ts", op: "edit" });
		expect(extractToolFileOp("write", { path: "a.ts" })).toEqual({ path: "a.ts", op: "write" });
	});

	it("returns undefined for non-file tools", () => {
		expect(extractToolFileOp("bash", { command: "ls" })).toBeUndefined();
		expect(extractToolFileOp("grep", { pattern: "x" })).toBeUndefined();
	});

	it("returns undefined for missing or non-string path", () => {
		expect(extractToolFileOp("read", {})).toBeUndefined();
		expect(extractToolFileOp("read", { path: "" })).toBeUndefined();
		expect(extractToolFileOp("read", { path: 42 })).toBeUndefined();
		expect(extractToolFileOp("read", null)).toBeUndefined();
		expect(extractToolFileOp("read", undefined)).toBeUndefined();
	});
});
