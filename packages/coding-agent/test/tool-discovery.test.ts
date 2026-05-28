import { describe, expect, test } from "vitest";
import { createToolDiscoveryIndex, type HiddenToolEntry } from "../src/core/tool-discovery.js";

function fakeDef(name: string): HiddenToolEntry["definition"] {
	// Tests only inspect identity, never execute. A bare placeholder is fine.
	return { name } as unknown as HiddenToolEntry["definition"];
}

function pdfEntry(): HiddenToolEntry {
	return {
		name: "pdf_extract",
		description: "Extract text and tables from PDF documents.",
		tags: ["pdf", "extract", "document"],
		definition: fakeDef("pdf_extract"),
	};
}

function sqlEntry(): HiddenToolEntry {
	return {
		name: "sql_query",
		description: "Run SQL queries against a relational database.",
		tags: ["sql", "database"],
		definition: fakeDef("sql_query"),
	};
}

function csvEntry(): HiddenToolEntry {
	return {
		name: "csv_summary",
		description: "Summarize columns and basic statistics from a CSV file.",
		tags: ["csv", "summary"],
		definition: fakeDef("csv_summary"),
	};
}

describe("ToolDiscoveryIndex", () => {
	test("register + search returns the matching entry for a query", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(pdfEntry());
		idx.register(sqlEntry());
		idx.register(csvEntry());

		const results = idx.search("pdf");
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.entry.name).toBe("pdf_extract");
	});

	test("BM25 ranks the closer match higher", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(pdfEntry());
		idx.register(sqlEntry());
		idx.register(csvEntry());

		const sqlResults = idx.search("SQL database");
		expect(sqlResults[0]!.entry.name).toBe("sql_query");

		const csvResults = idx.search("CSV statistics");
		expect(csvResults[0]!.entry.name).toBe("csv_summary");
	});

	test("search returns empty array on no match", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(pdfEntry());
		expect(idx.search("zzz_no_overlap_word")).toEqual([]);
	});

	test("activate returns the definition and adds to activatedNames", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(pdfEntry());
		const def = idx.activate("pdf_extract");
		expect(def).toBeDefined();
		expect(idx.activatedNames()).toContain("pdf_extract");
	});

	test("activate unknown name returns undefined", () => {
		const idx = createToolDiscoveryIndex();
		expect(idx.activate("nope")).toBeUndefined();
		expect(idx.activatedNames()).toEqual([]);
	});

	test("unregister removes the entry", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(pdfEntry());
		expect(idx.unregister("pdf_extract")).toBe(true);
		expect(idx.search("pdf")).toEqual([]);
		expect(idx.listHidden()).toEqual([]);
		expect(idx.unregister("pdf_extract")).toBe(false);
	});

	test("clear empties hidden and activated", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(pdfEntry());
		idx.activate("pdf_extract");
		idx.clear();
		expect(idx.listHidden()).toEqual([]);
		expect(idx.activatedNames()).toEqual([]);
	});
});
