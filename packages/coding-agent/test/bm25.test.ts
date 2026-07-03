import { describe, expect, it } from "vitest";
import { bm25Score, buildCorpus, computeDocStats, foldForSearch, tokenize } from "../src/core/search/bm25.js";

describe("bm25 tokenizer (Unicode + diacritic folding)", () => {
	it("folds diacritics so accented and unaccented spellings tokenize identically", () => {
		expect(tokenize("função")).toEqual(["funcao"]);
		expect(tokenize("função")).toEqual(tokenize("funcao"));
		expect(tokenize("compactação")).toEqual(tokenize("compactacao"));
		expect(tokenize("CÓDIGO")).toEqual(tokenize("codigo"));
	});

	it("keeps Portuguese content words instead of shredding them to ASCII prefixes", () => {
		// The old /[a-z0-9_]+/ regex turned "função" into "fun" (the tail "o" fell
		// under the length filter). The Unicode regex keeps the whole word.
		const toks = tokenize("A função de compactação foi corrigida");
		expect(toks).toContain("funcao");
		expect(toks).toContain("compactacao");
		expect(toks).toContain("corrigida");
		expect(toks).not.toContain("fun");
	});

	it("tokenizes multi-script / underscore identifiers", () => {
		expect(tokenize("src/core/history_recall.ts")).toEqual(["src", "core", "history_recall", "ts"]);
	});

	it("drops single-character tokens", () => {
		expect(tokenize("a b c função")).toEqual(["funcao"]);
	});

	it("removes English stopwords", () => {
		expect(tokenize("the answer is in the file")).toEqual(["answer", "file"]);
	});

	it("removes Portuguese stopwords (folded forms too)", () => {
		// "de", "da", "com", "para" are stops; "são" folds to the stop "sao".
		expect(tokenize("de da com para são")).toEqual([]);
		expect(tokenize("a correção da função para o código")).toEqual(["correcao", "funcao", "codigo"]);
	});

	it("foldForSearch is length-preserving for precomposed accents", () => {
		// 1:1 code-unit mapping is what lets bank snippets keep their accents.
		const original = "função compactação";
		expect(foldForSearch(original)).toBe("funcao compactacao");
		expect(foldForSearch(original).length).toBe(original.length);
	});
});

describe("bm25 scoring core", () => {
	it("ranks the doc containing the query terms highest", () => {
		const texts = [
			"compiler optimization removes dead code",
			"the kitchen has new appliances",
			"compiler emits unused variable warnings",
		];
		const docs = texts.map(computeDocStats);
		const { avgLen, df } = buildCorpus(docs);
		const query = tokenize("compiler optimization");
		const scores = docs.map((d) => bm25Score(query, d, avgLen, df, docs.length).score);
		expect(scores[0]).toBeGreaterThan(scores[1]);
		expect(scores[0]).toBeGreaterThan(scores[2]);
		expect(scores[1]).toBe(0);
	});

	it("matches Portuguese prose regardless of the query's accents", () => {
		const texts = [
			"Implementamos a função de compactação para o histórico da sessão",
			"The kitchen renovation is complete",
		];
		const docs = texts.map(computeDocStats);
		const { avgLen, df } = buildCorpus(docs);
		for (const q of ["função compactação", "funcao compactacao"]) {
			const query = tokenize(q);
			const s0 = bm25Score(query, docs[0], avgLen, df, docs.length).score;
			const s1 = bm25Score(query, docs[1], avgLen, df, docs.length).score;
			expect(s0).toBeGreaterThan(0);
			expect(s0).toBeGreaterThan(s1);
		}
	});

	it("reports the best-contributing term for snippet centring", () => {
		const docs = ["alpha beta beta beta gamma"].map(computeDocStats);
		const { avgLen, df } = buildCorpus(docs);
		const { bestTerm } = bm25Score(tokenize("alpha beta"), docs[0], avgLen, df, docs.length);
		expect(bestTerm).toBe("beta"); // higher term frequency
	});
});
