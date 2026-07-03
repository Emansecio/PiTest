/**
 * Shared BM25 primitives — a single tokenizer + ranking core for every
 * in-process keyword search in the coding agent (`recall_history` over the
 * compacted-away window and the project-local Hindsight bank).
 *
 * Before this module the two callers each carried a private copy of the
 * tokenizer, the stopword list and the BM25 scorer (~150 lines duplicated,
 * drifting apart — bank's scorer tracked a best-matching term for snippets,
 * recall-history's did not). They now import from here.
 *
 * Unicode-first tokenization. The user of this repo writes in Portuguese, so
 * an ASCII-only `/[a-z0-9_]+/` was actively wrong: "função" tokenized to
 * "fun" (the tail "o" fell under the length filter) and never matched the
 * unaccented spelling "funcao". Here every token is:
 *   1. diacritic-folded — NFD-decomposed, then combining marks stripped, so
 *      "função" and "funcao" collapse to the same token "funcao";
 *   2. lowercased Unicode-aware;
 *   3. matched with `/[\p{L}\p{N}_]+/gu` (any-script letters/digits + `_`).
 * The same pipeline runs over documents AND queries, so folding is symmetric
 * and an accented query finds unaccented prose and vice-versa.
 *
 * Note: folding is not stemming. "função" (→ "funcao") and "funções"
 * (→ "funcoes") remain distinct tokens; this module fixes accent/spelling
 * mismatch, not singular/plural conflation.
 */

/** BM25 free parameters — classic defaults, shared by all callers. */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

/** Any-script letters/digits plus underscore. `u` flag enables `\p{…}`. */
const TOKEN_REGEX = /[\p{L}\p{N}_]+/gu;

/**
 * English function words. Kept as a separate set from the Portuguese list so
 * either can evolve independently; both are applied.
 */
const STOPWORDS_EN = [
	"the",
	"a",
	"an",
	"and",
	"or",
	"of",
	"to",
	"in",
	"is",
	"it",
	"for",
	"on",
	"at",
	"by",
	"as",
	"be",
	"this",
	"that",
	"with",
	"are",
	"was",
	"were",
];

/**
 * Portuguese function words (articles / prepositions / common pronouns +
 * high-frequency auxiliaries). Stored already diacritic-folded so they match
 * the folded token stream ("são" → "sao", "não" → "nao"). Single-letter forms
 * ("e", "o", "a") are omitted — the min-length-2 filter already drops them.
 *
 * Trade-off: a few of these collide with meaningful English/technical terms
 * ("os" ~ "OS", "no"/"do" as English words). They are dropped symmetrically
 * from both documents and queries, so ranking stays internally consistent; the
 * gain (Portuguese prose stops not dominating BM25) outweighs the rare loss.
 */
const STOPWORDS_PT = [
	"de",
	"do",
	"da",
	"dos",
	"das",
	"que",
	"para",
	"com",
	"uma",
	"um",
	"uns",
	"umas",
	"os",
	"em",
	"no",
	"na",
	"nos",
	"nas",
	"por",
	"se",
	"ao",
	"aos",
	"mas",
	"ou",
	"como",
	"mais",
	"foi",
	"ser",
	"tem",
	"sao",
	"nao",
	"num",
	"numa",
	"pelo",
	"pela",
	"seu",
	"sua",
	"isso",
	"este",
	"esta",
	"esse",
	"essa",
	"ja",
	"entre",
	"sem",
	"sobre",
];

const STOPWORDS = new Set<string>([...STOPWORDS_EN, ...STOPWORDS_PT]);

/**
 * Diacritic-fold + lowercase a string for search. NFD splits an accented
 * character into base + combining mark(s); `\p{M}` strips the marks; the
 * result is lowercased. "FUNÇÃO", "função" and "funcao" all become "funcao".
 */
export function foldForSearch(text: string): string {
	return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * Fold, split into tokens, drop 1-char tokens and stopwords. Applied
 * identically to documents and queries so matching is symmetric.
 */
export function tokenize(text: string): string[] {
	const matches = foldForSearch(text).match(TOKEN_REGEX);
	if (!matches) return [];
	const out: string[] = [];
	for (const tok of matches) {
		if (tok.length < 2) continue;
		if (STOPWORDS.has(tok)) continue;
		out.push(tok);
	}
	return out;
}

/** Per-document token statistics: total length + per-term frequency. */
export interface DocStats {
	length: number;
	termFreq: Map<string, number>;
}

/** Tokenize one document's text into its `DocStats` (length + term frequencies). */
export function computeDocStats(text: string): DocStats {
	const tokens = tokenize(text);
	const termFreq = new Map<string, number>();
	for (const tok of tokens) {
		termFreq.set(tok, (termFreq.get(tok) ?? 0) + 1);
	}
	return { length: tokens.length, termFreq };
}

/**
 * Corpus-level statistics over a set of docs: average document length and
 * document frequency per term. Cheap (iterates cached `DocStats`), so callers
 * recompute it per query while caching the expensive per-doc tokenization.
 */
export function buildCorpus(docs: DocStats[]): { avgLen: number; df: Map<string, number> } {
	const df = new Map<string, number>();
	let total = 0;
	for (const doc of docs) {
		for (const tok of doc.termFreq.keys()) {
			df.set(tok, (df.get(tok) ?? 0) + 1);
		}
		total += doc.length;
	}
	const avgLen = docs.length > 0 ? total / docs.length : 0;
	return { avgLen, df };
}

/**
 * Classic BM25 (k1=1.5, b=0.75) score of one doc against the query tokens.
 * Also returns the single term contributing the most to the score, which
 * snippet extractors use to centre an excerpt; callers that don't need it
 * (recall-history) simply ignore `bestTerm`.
 */
export function bm25Score(
	queryTokens: string[],
	doc: DocStats,
	avgLen: number,
	df: Map<string, number>,
	totalDocs: number,
): { score: number; bestTerm: string | undefined } {
	let score = 0;
	let bestTermScore = 0;
	let bestTerm: string | undefined;
	for (const term of queryTokens) {
		const tf = doc.termFreq.get(term);
		if (!tf) continue;
		const dfTerm = df.get(term) ?? 0;
		const idf = Math.log(1 + (totalDocs - dfTerm + 0.5) / (dfTerm + 0.5));
		const norm = avgLen > 0 ? doc.length / avgLen : 1;
		const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * norm);
		const contribution = idf * ((tf * (BM25_K1 + 1)) / Math.max(denom, 1e-9));
		score += contribution;
		if (contribution > bestTermScore) {
			bestTermScore = contribution;
			bestTerm = term;
		}
	}
	return { score, bestTerm };
}
