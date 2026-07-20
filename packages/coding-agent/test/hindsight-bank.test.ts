import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { type HindsightBank, openBank } from "../src/core/hindsight/bank.js";
import {
	formatHindsightHintForPrompt,
	formatSessionSummariesForPrompt,
	setCurrentHindsightBank,
} from "../src/core/hindsight/index.js";

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

	test("search filters results below the BM25 score floor", () => {
		const { bank } = freshBank();
		// Saturate the corpus with a shared term so idf collapses and scores stay << 0.15.
		for (let i = 0; i < 50; i++) {
			bank.add({ kind: "fact", body: `entry ${i} mentions sharedtok filler content` });
		}
		expect(bank.search({ query: "sharedtok", limit: 10 })).toEqual([]);

		// A distinctive match on a single entry should clear the floor.
		bank.add({ kind: "fact", body: "zephyrquantum pipeline handles authentication tokens" });
		const strong = bank.search({ query: "zephyrquantum authentication", limit: 5 });
		expect(strong.length).toBeGreaterThan(0);
		expect(strong[0]!.entry.body).toContain("zephyrquantum");
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

	test("search recovers Portuguese entries from an unaccented query (N6)", () => {
		const { bank } = freshBank();
		bank.add({ kind: "fact", body: "A função de compactação preserva o histórico da sessão" });
		bank.add({ kind: "fact", body: "the kitchen has new appliances installed today" });

		// Query without diacritics still ranks the accented Portuguese entry first.
		const results = bank.search({ query: "funcao compactacao" });
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.entry.body).toContain("função de compactação");
		// The matched snippet keeps its original accents (folding is length-preserving).
		expect(results[0]!.matchedSnippet).toContain("função");
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

	test("add redacts a secret in the body before it hits disk (synthetic token)", () => {
		const { bank, path } = freshBank();
		// Synthetic OpenAI-shaped token — not a real credential — just to exercise
		// the redaction path the bank now routes writes through.
		const synthetic = "sk-proj-abcDEF1234567890ghijKLMNsynthetic";
		bank.add({
			kind: "fact",
			body: `remember this key: ${synthetic}`,
			subject: "leaked secret repro",
		});
		const text = readFileSync(path, "utf-8");
		expect(text).not.toContain(synthetic);
		expect(text).toContain("[REDACTED:openai-key]");
		// In-memory copy is untouched — only the disk write is scrubbed.
		expect(bank.all()[0]!.body).toContain(synthetic);
	});

	test("delete rewrite also redacts remaining entries' secrets (synthetic token)", () => {
		const { bank, path } = freshBank();
		const synthetic = "sk-proj-abcDEF1234567890ghijKLMNsynthetic";
		const toDelete = bank.add({ kind: "fact", body: "throwaway entry" });
		bank.add({ kind: "fact", body: `secret to keep: ${synthetic}` });
		bank.delete(toDelete.id);
		const text = readFileSync(path, "utf-8");
		expect(text).not.toContain(synthetic);
		expect(text).toContain("[REDACTED:openai-key]");
	});

	test("enforceLimit on add keeps at most N entries (evicts oldest)", async () => {
		const path = freshBankPath();
		const bank = openBank(path, { maxEntries: 2 });
		bank.add({ kind: "fact", body: "a", subject: "a" });
		await new Promise((r) => setTimeout(r, 5));
		bank.add({ kind: "fact", body: "b", subject: "b" });
		await new Promise((r) => setTimeout(r, 5));
		bank.add({ kind: "fact", body: "c", subject: "c" });
		const all = bank.all();
		expect(all).toHaveLength(2);
		expect(all.map((e) => e.subject).sort()).toEqual(["b", "c"]);
	});
});

describe("hindsight prompt formatting (E4)", () => {
	test("formatHindsightHintForPrompt indexes summaries without inlining bodies", () => {
		const { bank } = freshBank();
		bank.add({ kind: "session-summary", body: "secret prior context", subject: "auth work" });
		setCurrentHindsightBank(bank);
		const hint = formatHindsightHintForPrompt();
		expect(hint).toContain("<hindsight_hint>");
		expect(hint).toContain("recall({ query:");
		expect(hint).toContain("auth work");
		expect(hint).not.toContain("secret prior context");
		const full = formatSessionSummariesForPrompt();
		expect(full).toContain("secret prior context");
		setCurrentHindsightBank(undefined);
	});
});
