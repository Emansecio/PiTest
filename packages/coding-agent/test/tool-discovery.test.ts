import { describe, expect, test } from "vitest";
import { buildHiddenToolHint, createToolDiscoveryIndex, type HiddenToolEntry } from "../src/core/tool-discovery.js";

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

	test("re-register replaces old indexed terms", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(pdfEntry());
		idx.register({
			...pdfEntry(),
			description: "Inspect spreadsheet formulas.",
			tags: ["spreadsheet"],
		});

		expect(idx.search("tables")).toEqual([]);
		expect(idx.search("spreadsheet")[0]!.entry.name).toBe("pdf_extract");
	});

	test("clear empties hidden and activated", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(pdfEntry());
		idx.activate("pdf_extract");
		idx.clear();
		expect(idx.listHidden()).toEqual([]);
		expect(idx.activatedNames()).toEqual([]);
	});

	test("camelCase queries match camelCase tool names/descriptions", () => {
		const idx = createToolDiscoveryIndex();
		idx.register({
			name: "renderMermaidDiagram",
			description: "Render a Mermaid diagram to an image.",
			definition: fakeDef("renderMermaidDiagram"),
		});
		// "render" / "diagram" are camel parts of the name; pre-split they were buried
		// in the single token "rendermermaiddiagram" and never matched.
		expect(idx.search("render diagram")[0]!.entry.name).toBe("renderMermaidDiagram");
	});

	test("letter↔digit boundary splits so 'bm 25' matches 'bm25'", () => {
		const idx = createToolDiscoveryIndex();
		idx.register({
			name: "search_tool_bm25",
			description: "BM25-rank hidden tools.",
			definition: fakeDef("search_tool_bm25"),
		});
		expect(idx.search("bm25")[0]!.entry.name).toBe("search_tool_bm25");
	});
});

describe("buildHiddenToolHint", () => {
	const entry = (name: string): HiddenToolEntry => ({
		name,
		description: `${name} description`,
		definition: fakeDef(name),
	});

	test("returns undefined with no index", () => {
		expect(buildHiddenToolHint(undefined, "x")).toBeUndefined();
	});

	test("exact hidden match activates the tool and tells the model to retry", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(entry("query_sqlite"));
		const hint = buildHiddenToolHint(idx, "query_sqlite");
		expect(hint).toContain("query_sqlite");
		expect(hint).toContain("activated");
		expect(idx.activatedNames()).toContain("query_sqlite");
	});

	test("near miss points at search_tool_bm25 without activating", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(entry("query_sqlite"));
		const hint = buildHiddenToolHint(idx, "query_sqlit");
		expect(hint).toContain("search_tool_bm25");
		expect(idx.activatedNames()).toEqual([]);
	});

	test("no match returns undefined", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(entry("query_sqlite"));
		expect(buildHiddenToolHint(idx, "totally_unrelated_xyz")).toBeUndefined();
	});

	test("already-activated exact name does not re-activate via the hint", () => {
		const idx = createToolDiscoveryIndex();
		idx.register(entry("query_sqlite"));
		idx.activate("query_sqlite");
		// Already active -> nothing hidden to surface; fall through to fuzzy (none).
		expect(buildHiddenToolHint(idx, "query_sqlite")).toBeUndefined();
	});
});
