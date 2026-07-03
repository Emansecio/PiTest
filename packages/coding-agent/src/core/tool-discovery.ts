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

import { suggestClosest } from "@pit/ai";
import { sliceSafe } from "../utils/surrogate.ts";
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

/**
 * Split one alphanumeric run on camelCase / acronym / letter↔digit boundaries so
 * a query term matches a tool name regardless of casing convention:
 *   "getHTTPResponse" -> ["get","http","response"]; "queryDB2" -> ["query","db","2"].
 * snake_case and kebab-case runs are already separated by the alnum tokenizer
 * (their separators aren't alphanumeric), so this only adds the INTRA-run camel
 * boundaries. Applied identically to query and document text, so the BM25 ranking
 * stays coherent — both sides fragment the same way.
 */
function splitWordParts(run: string): string[] {
	return run
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camel: fooBar -> foo Bar
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // acronym: HTTPResponse -> HTTP Response
		.replace(/([A-Za-z])([0-9])/g, "$1 $2") // letter->digit: bm25 -> bm 25
		.replace(/([0-9])([A-Za-z])/g, "$1 $2") // digit->letter: 2fa -> 2 fa
		.split(" ");
}

function tokenize(text: string): string[] {
	if (!text) return [];
	const tokens: string[] = [];
	const re = /[a-zA-Z0-9]+/g;
	for (;;) {
		const match = re.exec(text);
		if (match === null) break;
		for (const part of splitWordParts(match[0])) {
			if (part.length > 0) tokens.push(part.toLowerCase());
		}
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
		// Match the run the same camel-aware way tokenize() builds query terms, so a
		// query subtoken ("response") still anchors the snippet to "getHTTPResponse".
		const parts = splitWordParts(match[0]);
		if (parts.some((p) => queryTerms.has(p.toLowerCase()))) {
			bestPos = match.index;
			break;
		}
	}
	if (bestPos < 0) {
		return description.length <= SNIPPET_WINDOW ? description : `${sliceSafe(description, 0, SNIPPET_WINDOW)}…`;
	}
	const half = Math.floor(SNIPPET_WINDOW / 2);
	const start = Math.max(0, bestPos - half);
	const end = Math.min(description.length, start + SNIPPET_WINDOW);
	const slice = sliceSafe(description, start, end);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < description.length ? "…" : "";
	return `${prefix}${slice}${suffix}`;
}

export function createToolDiscoveryIndex(): ToolDiscoveryIndex {
	const docs = new Map<string, IndexedDoc>();
	const activated = new Map<string, ToolDef>();
	const docFreq = new Map<string, number>();
	let totalLength = 0;

	function addDocStats(doc: IndexedDoc): void {
		totalLength += doc.length;
		for (const term of doc.termFreq.keys()) {
			docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
		}
	}

	function removeDocStats(doc: IndexedDoc): void {
		totalLength -= doc.length;
		for (const term of doc.termFreq.keys()) {
			const next = (docFreq.get(term) ?? 0) - 1;
			if (next > 0) {
				docFreq.set(term, next);
			} else {
				docFreq.delete(term);
			}
		}
	}

	function search(query: string, limit = 5): ToolDiscoverySearchResult[] {
		const queryTokens = tokenize(query);
		if (queryTokens.length === 0 || docs.size === 0) return [];
		const queryTermSet = new Set(queryTokens);

		const totalDocs = docs.size;
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
			const existing = docs.get(entry.name);
			if (existing) {
				removeDocStats(existing);
			}
			const doc = buildDoc(entry);
			docs.set(entry.name, doc);
			addDocStats(doc);
		},
		unregister(name) {
			const doc = docs.get(name);
			if (!doc) return false;
			removeDocStats(doc);
			docs.delete(name);
			return true;
		},
		activate(name) {
			// Idempotent: the doc is pulled out of `docs` on first activation, but
			// callers legitimately re-activate the SAME name a second time and still
			// expect the definition back — notably search_tool_bm25 activates a
			// deferred tool, then agent-session._reconcileDiscoveryActivations calls
			// activate() again to fetch the definition it registers as a custom tool.
			// Serve those from the durable `activated` record instead of undefined.
			const already = activated.get(name);
			if (already) return already;
			const doc = docs.get(name);
			if (!doc) return undefined;
			// Move the doc OUT of the hidden index — an activated tool must stop
			// counting toward listHidden() (over-counting broke the count>0 nudge
			// stability the pre-marker system-prompt snapshot relies on) and stop
			// being a search() candidate (re-suggesting a tool that is already
			// active). `activated` is the durable record of what got pulled in.
			removeDocStats(doc);
			docs.delete(name);
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
			docFreq.clear();
			totalLength = 0;
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

// Match the "did you mean" calibration used for the active-tool unknown-tool
// suggestion (agent-loop.ts) so the two hint paths feel consistent.
const HIDDEN_HINT_MAX_DISTANCE = 3;
const HIDDEN_HINT_PREFIX_MIN_OVERLAP = 3;

/**
 * Build a recovery hint when the model called a tool name that is NOT active but
 * exists (exactly or as a close typo) in the hidden discovery index. On an EXACT
 * match the tool is activated as a side effect — the post-turn reconcile brings it
 * onto the surface, so the model only needs to call it again. On a near miss it is
 * pointed at `search_tool_bm25`. Returns undefined when nothing relevant matches.
 *
 * Wired into `@pit/agent-core`'s unknown-tool formatter via setUnknownToolHintProvider.
 */
export function buildHiddenToolHint(index: ToolDiscoveryIndex | undefined, name: string): string | undefined {
	if (!index) return undefined;
	const hidden = index.listHidden();
	if (hidden.length === 0) return undefined;
	// Candidates are tools still HIDDEN — drop any already pulled onto the surface,
	// so an exact-but-active name never produces a misleading "it's hidden" hint.
	const activeAlready = new Set(index.activatedNames());
	const names = hidden.map((h) => h.name).filter((n) => !activeAlready.has(n));
	if (names.length === 0) return undefined;
	if (names.includes(name)) {
		index.activate(name);
		return `"${name}" is a specialized tool that was not in the active set — it has now been activated. Call it again and it will run.`;
	}
	const close = suggestClosest(name, names, {
		maxDistance: HIDDEN_HINT_MAX_DISTANCE,
		prefixMinOverlap: HIDDEN_HINT_PREFIX_MIN_OVERLAP,
	});
	if (close) {
		return `"${close}" is a specialized tool not in the active set. Run search_tool_bm25({ query: "<the capability you need>", activate_top: true }) to activate it, then call it.`;
	}
	return undefined;
}
