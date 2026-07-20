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
import { bm25Score, buildCorpus, computeDocStats, type DocStats, foldForSearch, tokenize } from "../search/bm25.ts";
import { redactForDisk } from "../secret-redactor.ts";
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
	/** Cap each NON-global scope at `perScopeMax`, evicting oldest within that scope. Returns count removed. */
	enforcePerScopeLimit(perScopeMax: number): number;
}

export interface OpenBankOptions {
	/** Hard ceiling on entry count. Oldest entries (by updatedAt) are evicted. */
	maxEntries?: number;
	/** Drop entries older than this many days on open. */
	pruneOlderThanDays?: number;
	/** Per non-global-scope ceiling. Evicts oldest within an over-cap scope on open. */
	perScopeMax?: number;
}

const SCOPE_BOOST = 1.25;
/** Minimum BM25 score for recall results — filters noisy near-misses (tool BM25 uses 0.1 for activation). */
const HINDSIGHT_MIN_SCORE = 0.15;

function entryHaystack(entry: HindsightEntry): string {
	const tags = entry.tags && entry.tags.length > 0 ? ` ${entry.tags.join(" ")}` : "";
	const subject = entry.subject ? ` ${entry.subject}` : "";
	return `${entry.body}${subject}${tags}`;
}

// Per-entry tokenization is the dominant cost of search() and only changes when
// an entry is added/removed. Entries are immutable objects (created once, never
// mutated; deleted entries leave the array and are GC'd from this WeakMap), so
// caching DocStats keyed by the entry object stays correct across queries.
const docStatsCache = new WeakMap<HindsightEntry, DocStats>();

function docStatsFor(entry: HindsightEntry): DocStats {
	const cached = docStatsCache.get(entry);
	if (cached) return cached;
	const stats = computeDocStats(entryHaystack(entry));
	docStatsCache.set(entry, stats);
	return stats;
}

function buildDocStats(entries: HindsightEntry[]): { docs: DocStats[]; avgLen: number; df: Map<string, number> } {
	const docs = entries.map(docStatsFor);
	const { avgLen, df } = buildCorpus(docs);
	return { docs, avgLen, df };
}

interface SearchStats {
	entries: HindsightEntry[];
	docs: DocStats[];
	avgLen: number;
	df: Map<string, number>;
}

function snippetAround(body: string, term: string | undefined, windowSize = 120): string | undefined {
	if (!term) return undefined;
	// `term` is a folded token (diacritics stripped, lowercased), so match it
	// against the folded body. For the common case — precomposed accents like
	// "função" — folding is length-preserving, so the index maps 1:1 back onto
	// the original `body` and the returned snippet keeps its accents. On ASCII
	// this is identical to the previous `body.toLowerCase()`.
	const folded = foldForSearch(body);
	const idx = folded.indexOf(term);
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
	const payload = entries.map((entry) => redactForDisk(JSON.stringify(entry))).join("\n");
	writeFileSync(tmp, payload ? `${payload}\n` : "", "utf-8");
	renameSync(tmp, filePath);
}

export function openBank(filePath: string, opts?: OpenBankOptions): HindsightBank {
	const entries: HindsightEntry[] = loadEntries(filePath);
	const byId = new Map<string, HindsightEntry>();
	for (const entry of entries) byId.set(entry.id, entry);
	const searchStatsCache = new Map<string, SearchStats>();
	const maxEntries = opts && typeof opts.maxEntries === "number" && opts.maxEntries > 0 ? opts.maxEntries : undefined;
	const perScopeMax =
		opts && typeof opts.perScopeMax === "number" && opts.perScopeMax > 0 ? opts.perScopeMax : undefined;

	function invalidateSearchStats(): void {
		searchStatsCache.clear();
	}

	function searchStatsFor(kinds: Set<HindsightKind> | undefined): SearchStats {
		const key = kinds ? Array.from(kinds).sort().join("\0") : "";
		const cached = searchStatsCache.get(key);
		if (cached) return cached;

		const candidates = kinds ? entries.filter((entry) => kinds.has(entry.kind)) : entries.slice();
		const { docs, avgLen, df } = buildDocStats(candidates);
		const stats = { entries: candidates, docs, avgLen, df };
		searchStatsCache.set(key, stats);
		return stats;
	}

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
				agentScope: input.agentScope,
			};
			entries.push(entry);
			byId.set(entry.id, entry);
			invalidateSearchStats();
			const line = `${redactForDisk(JSON.stringify(entry))}\n`;
			appendFileSync(filePath, line, "utf-8");
			// Keep bank bounded during long sessions (limits previously only ran at open).
			if (perScopeMax !== undefined) bank.enforcePerScopeLimit(perScopeMax);
			if (maxEntries !== undefined) bank.enforceLimit(maxEntries);
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
			invalidateSearchStats();
			atomicRewrite(filePath, entries);
			return true;
		},

		search(opts) {
			const limit = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : 10;
			const kinds = opts.kinds && opts.kinds.length > 0 ? new Set<HindsightKind>(opts.kinds) : undefined;
			const stats = searchStatsFor(kinds);
			if (stats.entries.length === 0) return [];

			const queryTokens = tokenize(opts.query);
			if (queryTokens.length === 0) return [];

			// buildDocStats pushes one doc per candidate in order, so docs[i] lines
			// up with candidates[i] — index directly instead of a Map<id> lookup.
			const scored: HindsightSearchResult[] = [];
			for (let i = 0; i < stats.entries.length; i++) {
				const entry = stats.entries[i];
				const doc = stats.docs[i];
				if (!doc) continue;
				const { score, bestTerm } = bm25Score(queryTokens, doc, stats.avgLen, stats.df, stats.entries.length);
				if (score <= HINDSIGHT_MIN_SCORE) continue;
				scored.push({
					entry,
					score,
					matchedSnippet: snippetAround(entry.body, bestTerm),
				});
			}
			let results = scored;
			if (opts.scopes) {
				const allowGlobal = opts.scopes.includes(null);
				const allowSet = new Set(opts.scopes.filter((s): s is string => typeof s === "string"));
				results = results.filter((r) =>
					r.entry.agentScope === undefined ? allowGlobal : allowSet.has(r.entry.agentScope),
				);
			}
			if (opts.boostScope !== undefined) {
				const target = opts.boostScope; // string | null
				for (const r of results) {
					if ((r.entry.agentScope ?? null) === target) r.score *= SCOPE_BOOST;
				}
			}
			results.sort((a, b) => b.score - a.score);
			return results.slice(0, limit);
		},

		all() {
			return entries.slice();
		},

		clear() {
			entries.length = 0;
			byId.clear();
			invalidateSearchStats();
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
			if (removed > 0) {
				invalidateSearchStats();
				atomicRewrite(filePath, entries);
			}
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
			invalidateSearchStats();
			atomicRewrite(filePath, entries);
			return removed;
		},

		enforcePerScopeLimit(perScopeMax) {
			if (!Number.isFinite(perScopeMax) || perScopeMax <= 0) return 0;
			const byScope = new Map<string, HindsightEntry[]>();
			for (const e of entries) {
				if (e.agentScope === undefined) continue; // global is exempt
				const bucket = byScope.get(e.agentScope);
				if (bucket) bucket.push(e);
				else byScope.set(e.agentScope, [e]);
			}
			const toDrop = new Set<string>();
			for (const bucket of byScope.values()) {
				if (bucket.length <= perScopeMax) continue;
				bucket.sort((a, b) => {
					const at = typeof a.updatedAt === "number" ? a.updatedAt : a.createdAt;
					const bt = typeof b.updatedAt === "number" ? b.updatedAt : b.createdAt;
					return bt - at; // newest first
				});
				for (const e of bucket.slice(perScopeMax)) toDrop.add(e.id);
			}
			if (toDrop.size === 0) return 0;
			for (let i = entries.length - 1; i >= 0; i--) {
				if (toDrop.has(entries[i].id)) {
					byId.delete(entries[i].id);
					entries.splice(i, 1);
				}
			}
			invalidateSearchStats();
			atomicRewrite(filePath, entries);
			return toDrop.size;
		},
	};

	if (opts) {
		if (typeof opts.pruneOlderThanDays === "number" && opts.pruneOlderThanDays > 0) {
			bank.pruneOlderThan(opts.pruneOlderThanDays);
		}
		if (typeof opts.perScopeMax === "number" && opts.perScopeMax > 0) {
			bank.enforcePerScopeLimit(opts.perScopeMax);
		}
		if (typeof opts.maxEntries === "number" && opts.maxEntries > 0) {
			bank.enforceLimit(opts.maxEntries);
		}
	}

	return bank;
}
