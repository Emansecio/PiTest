/**
 * ToolDiscoveryIndex
 *
 * Hidden tool index for prompt-token savings: register specialized tools that
 * are NOT included in the model's default tool surface, then let the model
 * pull them in on demand via the `search_tool_bm25` tool.
 *
 * Pattern: register-hidden -> search -> activate -> use.
 *
 * Single-process; no locking. Mirrors `preview-queue.ts` and the hindsight
 * bank registry: a module-level "current index" is set at session boot and
 * cleared on dispose, so tools can pull the active index on demand.
 */

import type { ToolDef } from "./tools/index.ts";

export interface HiddenToolEntry {
	name: string;
	description: string;
	promptSnippet?: string;
	tags?: string[];
	/** Full definition, ready to activate. */
	definition: ToolDef;
}

export interface ToolDiscoverySearchResult {
	entry: HiddenToolEntry;
	score: number;
	snippet: string;
}

export interface ToolDiscoveryIndex {
	register(entry: HiddenToolEntry): void;
	unregister(name: string): boolean;
	/** Move entry from hidden -> activated; returns the def. Idempotent. */
	activate(name: string): ToolDef | undefined;
	activatedNames(): string[];
	search(query: string, limit?: number): ToolDiscoverySearchResult[];
	listHidden(): HiddenToolEntry[];
	clear(): void;
}

// ---------------------------------------------------------------------------
// BM25 tokenization + scoring (k1=1.5, b=0.75)
// ---------------------------------------------------------------------------

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const SNIPPET_WINDOW = 120;

function tokenize(text: string): string[] {
	if (!text) return [];
	const tokens: string[] = [];
	const re = /[a-zA-Z0-9]+/g;
	for (;;) {
		const match = re.exec(text);
		if (match === null) break;
		tokens.push(match[0].toLowerCase());
	}
	return tokens;
}

function entryDocText(entry: HiddenToolEntry): string {
	const parts = [entry.name, entry.description];
	if (entry.promptSnippet) parts.push(entry.promptSnippet);
	if (entry.tags && entry.tags.length > 0) parts.push(entry.tags.join(" "));
	return parts.join(" ");
}

interface IndexedDoc {
	entry: HiddenToolEntry;
	tokens: string[];
	length: number;
	termFreq: Map<string, number>;
}

function buildDoc(entry: HiddenToolEntry): IndexedDoc {
	const tokens = tokenize(entryDocText(entry));
	const termFreq = new Map<string, number>();
	for (const tok of tokens) {
		termFreq.set(tok, (termFreq.get(tok) ?? 0) + 1);
	}
	return { entry, tokens, length: tokens.length, termFreq };
}

function findBestSnippet(description: string, queryTerms: Set<string>): string {
	if (!description) return "";
	const re = /[a-zA-Z0-9]+/g;
	let bestPos = -1;
	for (;;) {
		const match = re.exec(description);
		if (match === null) break;
		const lower = match[0].toLowerCase();
		if (queryTerms.has(lower)) {
			bestPos = match.index;
			break;
		}
	}
	if (bestPos < 0) {
		return description.length <= SNIPPET_WINDOW ? description : `${description.slice(0, SNIPPET_WINDOW)}…`;
	}
	const half = Math.floor(SNIPPET_WINDOW / 2);
	const start = Math.max(0, bestPos - half);
	const end = Math.min(description.length, start + SNIPPET_WINDOW);
	const slice = description.slice(start, end);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < description.length ? "…" : "";
	return `${prefix}${slice}${suffix}`;
}

export function createToolDiscoveryIndex(): ToolDiscoveryIndex {
	const docs = new Map<string, IndexedDoc>();
	const activated = new Map<string, ToolDef>();

	function search(query: string, limit = 5): ToolDiscoverySearchResult[] {
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0 || docs.size === 0) return [];
		const queryTermSet = new Set(queryTokens);

		// Document frequency per query term.
		const docFreq = new Map<string, number>();
		for (const term of queryTermSet) {
			let df = 0;
			for (const doc of docs.values()) {
				if (doc.termFreq.has(term)) df += 1;
			}
			docFreq.set(term, df);
		}

		const totalDocs = docs.size;
		let totalLength = 0;
		for (const doc of docs.values()) totalLength += doc.length;
		const avgDocLength = totalLength / totalDocs || 1;

		const scored: ToolDiscoverySearchResult[] = [];
		for (const doc of docs.values()) {
			let score = 0;
			for (const term of queryTermSet) {
				const tf = doc.termFreq.get(term);
				if (!tf) continue;
				const df = docFreq.get(term) ?? 0;
				// BM25 IDF with +1 smoothing to keep non-negative.
				const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
				const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / avgDocLength);
				score += idf * ((tf * (BM25_K1 + 1)) / denom);
			}
			if (score > 0) {
				scored.push({
					entry: doc.entry,
					score,
					snippet: findBestSnippet(doc.entry.description, queryTermSet),
				});
			}
		}

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, Math.max(0, limit));
	}

	return {
		register(entry) {
			docs.set(entry.name, buildDoc(entry));
		},
		unregister(name) {
			return docs.delete(name);
		},
		activate(name) {
			const doc = docs.get(name);
			if (!doc) return undefined;
			activated.set(name, doc.entry.definition);
			return doc.entry.definition;
		},
		activatedNames() {
			return Array.from(activated.keys());
		},
		search,
		listHidden() {
			return Array.from(docs.values()).map((d) => d.entry);
		},
		clear() {
			docs.clear();
			activated.clear();
		},
	};
}

// ---------------------------------------------------------------------------
// Module-level "current session" registry. AgentSession publishes the index at
// session boot; tools pull it on demand inside execute().
// ---------------------------------------------------------------------------

let currentToolDiscoveryIndex: ToolDiscoveryIndex | undefined;

export function setCurrentToolDiscoveryIndex(idx: ToolDiscoveryIndex | undefined): void {
	currentToolDiscoveryIndex = idx;
}

export function getCurrentToolDiscoveryIndex(): ToolDiscoveryIndex | undefined {
	return currentToolDiscoveryIndex;
}
