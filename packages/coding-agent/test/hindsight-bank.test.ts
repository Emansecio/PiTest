import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { type HindsightBank, openBank } from "../src/core/hindsight/bank.js";

let tmpRoot: string;

function freshBankPath(): string {
	return join(tmpRoot, `bank-${Math.random().toString(36).slice(2)}.jsonl`);
}

function freshBank(): { bank: HindsightBank; path: string } {
	const path = freshBankPath();
	return { bank: openBank(path), path };
}

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "hindsight-test-"));
});

afterAll(() => {
	// Cleanup happens implicitly per-test via fresh dirs, but try a final sweep.
	try {
		if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
	} catch {
		// Best-effort cleanup
	}
});

describe("HindsightBank", () => {
	test("add appends to JSONL file on disk", () => {
		const { bank, path } = freshBank();
		const entry = bank.add({
			kind: "fact",
			body: "the answer is 42",
			subject: "math",
		});
		expect(entry.id).toBeDefined();
		expect(existsSync(path)).toBe(true);
		const text = readFileSync(path, "utf-8");
		const lines = text.split("\n").filter(Boolean);
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!);
		expect(parsed.body).toBe("the answer is 42");
		expect(parsed.kind).toBe("fact");
	});

	test("add then re-open loads existing entries", () => {
		const path = freshBankPath();
		const a = openBank(path);
		a.add({ kind: "fact", body: "persisted body content here" });
		a.add({ kind: "decision", body: "another persisted decision" });

		const b = openBank(path);
		expect(b.all()).toHaveLength(2);
	});

	test("search returns the most relevant entry by BM25", () => {
		const { bank } = freshBank();
		bank.add({ kind: "fact", body: "compiler optimization removes dead code branches" });
		bank.add({ kind: "fact", body: "the kitchen has new appliances installed today" });
		bank.add({ kind: "fact", body: "compiler emits warnings about unused variables" });

		const results = bank.search({ query: "compiler optimization" });
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.entry.body).toContain("compiler optimization");
	});

	test("search returns empty array for an unmatched query", () => {
		const { bank } = freshBank();
		bank.add({ kind: "fact", body: "alpha beta gamma" });
		expect(bank.search({ query: "zzzqqq_no_overlap_word" })).toEqual([]);
	});

	test("delete removes from in-memory + rewrites file", () => {
		const { bank, path } = freshBank();
		const a = bank.add({ kind: "fact", body: "keep this entry around" });
		const b = bank.add({ kind: "fact", body: "remove this one please" });
		expect(bank.delete(b.id)).toBe(true);
		expect(bank.get(b.id)).toBeUndefined();
		expect(bank.all()).toHaveLength(1);
		const text = readFileSync(path, "utf-8");
		expect(text).toContain(a.id);
		expect(text).not.toContain(b.id);
		expect(bank.delete("does-not-exist")).toBe(false);
	});

	test("clear empties everything", () => {
		const { bank, path } = freshBank();
		bank.add({ kind: "fact", body: "first entry" });
		bank.add({ kind: "fact", body: "second entry" });
		bank.clear();
		expect(bank.all()).toEqual([]);
		expect(readFileSync(path, "utf-8")).toBe("");
	});

	test("search respects kind filter", () => {
		const { bank } = freshBank();
		bank.add({ kind: "fact", body: "shared word marker here" });
		bank.add({ kind: "decision", body: "shared word marker different" });
		const onlyFacts = bank.search({ query: "marker", kinds: ["fact"] });
		expect(onlyFacts.every((r) => r.entry.kind === "fact")).toBe(true);
		expect(onlyFacts).toHaveLength(1);
	});

	test("search reflects entries added after a cached filtered search", () => {
		const { bank } = freshBank();
		bank.add({ kind: "fact", body: "shared word marker here" });
		expect(bank.search({ query: "late", kinds: ["fact"] })).toEqual([]);

		bank.add({ kind: "fact", body: "late marker appears after cache" });
		const results = bank.search({ query: "late", kinds: ["fact"] });
		expect(results).toHaveLength(1);
		expect(results[0]!.entry.body).toContain("late marker");
	});

	test("search stops returning deleted entries after a cached search", () => {
		const { bank } = freshBank();
		const entry = bank.add({ kind: "fact", body: "temporary marker for deletion" });
		expect(bank.search({ query: "temporary", kinds: ["fact"] })).toHaveLength(1);

		expect(bank.delete(entry.id)).toBe(true);
		expect(bank.search({ query: "temporary", kinds: ["fact"] })).toEqual([]);
	});

	// TODO: enable once `pruneOlderThan` lands on HindsightBank.
	test.skip("pruneOlderThan(days) removes entries older than the cutoff", () => {
		// pruneOlderThan is not yet present on the bank API; another agent will add it.
	});

	// TODO: enable once `enforceLimit` lands on HindsightBank.
	test.skip("enforceLimit(N) keeps most-recent N", () => {
		// enforceLimit is not yet present on the bank API; another agent will add it.
	});
});
