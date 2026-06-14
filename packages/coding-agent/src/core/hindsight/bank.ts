/**
 * Project-local Hindsight bank backed by a JSONL file.
 *
 * - Loads all entries into memory on `openBank`.
 * - `add` appends a single line and updates the in-memory array.
 * - `delete` performs an atomic rewrite (tmp + rename).
 * - `search` runs a tiny inlined BM25 over body + subject + tags. No deps.
 *
 * Single-process; no file locking. Good enough for one coding-agent session.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { HindsightEntry, HindsightKind, HindsightSearchOptions, HindsightSearchResult } from "./types.ts";

export interface HindsightBank {
	add(input: Omit<HindsightEntry, "id" | "createdAt" | "updatedAt">): HindsightEntry;
	get(id: string): HindsightEntry | undefined;
	delete(id: string): boolean;
	search(opts: HindsightSearchOptions): HindsightSearchResult[];
	all(): HindsightEntry[];
	clear(): void;
	/** Drop entries older than `days` (by `updatedAt`). Returns count removed. */
	pruneOlderThan(days: number): number;
	/** Keep at most `maxEntries`, evicting oldest by `updatedAt`. Returns count removed. */
	enforceLimit(maxEntries: number): number;
}

export interface OpenBankOptions {
	/** Hard ceiling on entry count. Oldest entries (by updatedAt) are evicted. */
	maxEntries?: number;
	/** Drop entries older than this many days on open. */
	pruneOlderThanDays?: number;
}

const TOKEN_REGEX = /[a-z0-9_]+/g;
const STOPWORDS = new Set([
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
]);

function tokenize(text: string): string[] {
	const out: string[] = [];
	const lower = text.toLowerCase();
	const matches = lower.match(TOKEN_REGEX);
	if (!matches) return out;
	for (const tok of matches) {
		if (tok.length < 2) continue;
		if (STOPWORDS.has(tok)) continue;
		out.push(tok);
	}
	return out;
}

function entryHaystack(entry: HindsightEntry): string {
	const tags = entry.tags && entry.tags.length > 0 ? ` ${entry.tags.join(" ")}` : "";
	const subject = entry.subject ? ` ${entry.subject}` : "";
	return `${entry.body}${subject}${tags}`;
}

interface DocStats {
	id: string;
	length: number;
	termFreq: Map<string, number>;
}

// Per-entry tokenization is the dominant cost of search() and only changes when
// an entry is added/removed. Entries are immutable objects (created once, never
// mutated; deleted entries leave the array and are GC'd from this WeakMap), so
// caching DocStats keyed by the entry object stays correct across queries.
const docStatsCache = new WeakMap<HindsightEntry, DocStats>();

function docStatsFor(entry: HindsightEntry): DocStats {
	const cached = docStatsCache.get(entry);
	if (cached) return cached;
	const tokens = tokenize(entryHaystack(entry));
	const termFreq = new Map<string, number>();
	for (const tok of tokens) {
		termFreq.set(tok, (termFreq.get(tok) ?? 0) + 1);
	}
	const stats: DocStats = { id: entry.id, length: tokens.length, termFreq };
	docStatsCache.set(entry, stats);
	return stats;
}

function buildDocStats(entries: HindsightEntry[]): { docs: DocStats[]; avgLen: number; df: Map<string, number> } {
	const docs: DocStats[] = [];
	const df = new Map<string, number>();
	let total = 0;
	for (const entry of entries) {
		const doc = docStatsFor(entry);
		for (const tok of doc.termFreq.keys()) {
			df.set(tok, (df.get(tok) ?? 0) + 1);
		}
		docs.push(doc);
		total += doc.length;
	}
	const avgLen = docs.length > 0 ? total / docs.length : 0;
	return { docs, avgLen, df };
}

/** Classic BM25 with k1=1.5, b=0.75. */
function bm25Score(
	queryTokens: string[],
	doc: DocStats,
	avgLen: number,
	df: Map<string, number>,
	totalDocs: number,
): { score: number; bestTerm: string | undefined } {
	const k1 = 1.5;
	const b = 0.75;
	let score = 0;
	let bestTermScore = 0;
	let bestTerm: string | undefined;
	for (const term of queryTokens) {
		const tf = doc.termFreq.get(term);
		if (!tf) continue;
		const dfTerm = df.get(term) ?? 0;
		const idf = Math.log(1 + (totalDocs - dfTerm + 0.5) / (dfTerm + 0.5));
		const norm = avgLen > 0 ? doc.length / avgLen : 1;
		const denom = tf + k1 * (1 - b + b * norm);
		const contribution = idf * ((tf * (k1 + 1)) / Math.max(denom, 1e-9));
		score += contribution;
		if (contribution > bestTermScore) {
			bestTermScore = contribution;
			bestTerm = term;
		}
	}
	return { score, bestTerm };
}

function snippetAround(body: string, term: string | undefined, windowSize = 120): string | undefined {
	if (!term) return undefined;
	const lower = body.toLowerCase();
	const idx = lower.indexOf(term);
	if (idx === -1) return undefined;
	const half = Math.floor(windowSize / 2);
	const start = Math.max(0, idx - half);
	const end = Math.min(body.length, idx + term.length + half);
	const prefix = start > 0 ? "…" : "";
	const suffix = end < body.length ? "…" : "";
	return `${prefix}${body.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

function parseLine(line: string): HindsightEntry | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const obj = JSON.parse(trimmed) as HindsightEntry;
		if (typeof obj.id === "string" && typeof obj.body === "string" && typeof obj.kind === "string") {
			return obj;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function loadEntries(filePath: string): HindsightEntry[] {
	if (!existsSync(filePath)) return [];
	const text = readFileSync(filePath, "utf-8");
	if (!text) return [];
	const lines = text.split(/\r?\n/);
	const out: HindsightEntry[] = [];
	for (const line of lines) {
		const entry = parseLine(line);
		if (entry) out.push(entry);
	}
	return out;
}

function atomicRewrite(filePath: string, entries: HindsightEntry[]): void {
	const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
	const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
	writeFileSync(tmp, payload ? `${payload}\n` : "", "utf-8");
	renameSync(tmp, filePath);
}

export function openBank(filePath: string, opts?: OpenBankOptions): HindsightBank {
	const entries: HindsightEntry[] = loadEntries(filePath);
	const byId = new Map<string, HindsightEntry>();
	for (const entry of entries) byId.set(entry.id, entry);

	const bank: HindsightBank = {
		add(input) {
			const now = Date.now();
			const entry: HindsightEntry = {
				id: randomUUID(),
				createdAt: now,
				updatedAt: now,
				kind: input.kind,
				subject: input.subject,
				body: input.body,
				tags: input.tags,
				source: input.source,
			};
			entries.push(entry);
			byId.set(entry.id, entry);
			const line = `${JSON.stringify(entry)}\n`;
			appendFileSync(filePath, line, "utf-8");
			return entry;
		},

		get(id) {
			return byId.get(id);
		},

		delete(id) {
			if (!byId.has(id)) return false;
			byId.delete(id);
			const idx = entries.findIndex((e) => e.id === id);
			if (idx !== -1) entries.splice(idx, 1);
			atomicRewrite(filePath, entries);
			return true;
		},

		search(opts) {
			const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 10;
			const kinds = opts.kinds && opts.kinds.length > 0 ? new Set<HindsightKind>(opts.kinds) : undefined;
			const candidates = kinds ? entries.filter((e) => kinds.has(e.kind)) : entries;
			if (candidates.length === 0) return [];

			const queryTokens = tokenize(opts.query);
			if (queryTokens.length === 0) return [];

			const { docs, avgLen, df } = buildDocStats(candidates);

			// buildDocStats pushes one doc per candidate in order, so docs[i] lines
			// up with candidates[i] — index directly instead of a Map<id> lookup.
			const scored: HindsightSearchResult[] = [];
			for (let i = 0; i < candidates.length; i++) {
				const entry = candidates[i];
				const doc = docs[i];
				if (!doc) continue;
				const { score, bestTerm } = bm25Score(queryTokens, doc, avgLen, df, candidates.length);
				if (score <= 0) continue;
				scored.push({
					entry,
					score,
					matchedSnippet: snippetAround(entry.body, bestTerm),
				});
			}
			scored.sort((a, b) => b.score - a.score);
			return scored.slice(0, limit);
		},

		all() {
			return entries.slice();
		},

		clear() {
			entries.length = 0;
			byId.clear();
			atomicRewrite(filePath, entries);
		},

		pruneOlderThan(days) {
			if (!Number.isFinite(days) || days <= 0) return 0;
			const cutoff = Date.now() - days * 86_400_000;
			let removed = 0;
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				const ts = typeof e.updatedAt === "number" ? e.updatedAt : e.createdAt;
				if (ts < cutoff) {
					entries.splice(i, 1);
					byId.delete(e.id);
					removed += 1;
				}
			}
			if (removed > 0) atomicRewrite(filePath, entries);
			return removed;
		},

		enforceLimit(maxEntries) {
			if (!Number.isFinite(maxEntries) || maxEntries <= 0) return 0;
			if (entries.length <= maxEntries) return 0;
			// LRU by updatedAt: keep newest. Sort descending and slice.
			entries.sort((a, b) => {
				const at = typeof a.updatedAt === "number" ? a.updatedAt : a.createdAt;
				const bt = typeof b.updatedAt === "number" ? b.updatedAt : b.createdAt;
				return bt - at;
			});
			const removed = entries.length - maxEntries;
			const dropped = entries.splice(maxEntries, removed);
			for (const d of dropped) byId.delete(d.id);
			atomicRewrite(filePath, entries);
			return removed;
		},
	};

	if (opts) {
		if (typeof opts.pruneOlderThanDays === "number" && opts.pruneOlderThanDays > 0) {
			bank.pruneOlderThan(opts.pruneOlderThanDays);
		}
		if (typeof opts.maxEntries === "number" && opts.maxEntries > 0) {
			bank.enforceLimit(opts.maxEntries);
		}
	}

	return bank;
}
