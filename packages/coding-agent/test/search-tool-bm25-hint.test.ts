import { describe, expect, it } from "vitest";
import { createToolDiscoveryIndex, type HiddenToolEntry } from "../src/core/tool-discovery.js";
import { createSearchToolBm25Definition } from "../src/core/tools/search-tool-bm25.js";

const ctx = {} as Parameters<ReturnType<typeof createSearchToolBm25Definition>["execute"]>[4];

function fakeDef(name: string): HiddenToolEntry["definition"] {
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

function obscureEntry(): HiddenToolEntry {
	return {
		name: "abcdef",
		description: "zzz unique filler with no shared tokens.",
		tags: ["zzz"],
		definition: fakeDef("abcdef"),
	};
}

describe("search_tool_bm25 zero-result hint", () => {
	it("suggests the closest hidden tool name on a typo query", async () => {
		const index = createToolDiscoveryIndex();
		index.register(obscureEntry());
		const tool = createSearchToolBm25Definition("/tmp", { index });
		// "abcdeg" shares no BM25 tokens with "abcdef" but is Levenshtein-1 away.
		const result = await tool.execute("call-1", { query: "abcdeg" }, undefined, undefined, ctx);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toContain('No hidden tool matches for query: "abcdeg".');
		expect(text).toContain('Did you mean "abcdef"?');
	});

	it("keeps a dry message when nothing is close", async () => {
		const index = createToolDiscoveryIndex();
		index.register(pdfEntry());
		const tool = createSearchToolBm25Definition("/tmp", { index });
		const result = await tool.execute("call-1", { query: "zzz_no_overlap_word" }, undefined, undefined, ctx);
		const text = result.content.map((c) => ("text" in c ? c.text : "")).join("");
		expect(text).toBe('No hidden tool matches for query: "zzz_no_overlap_word".');
		expect(text).not.toContain("Did you mean");
	});
});
