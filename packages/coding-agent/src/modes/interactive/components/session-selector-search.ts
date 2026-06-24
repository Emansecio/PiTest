import { fuzzyMatch } from "@pit/tui";
import type { SessionInfo } from "../../../core/session-manager.ts";

export type SortMode = "threaded" | "recent" | "relevance";

export type NameFilter = "all" | "named";

export interface ParsedSearchQuery {
	mode: "tokens" | "regex";
	tokens: { kind: "fuzzy" | "phrase"; value: string }[];
	regex: RegExp | null;
	/** If set, parsing failed and we should treat query as non-matching. */
	error?: string;
}

export interface MatchResult {
	matches: boolean;
	/** Lower is better; only meaningful when matches === true */
	score: number;
}

function normalizeWhitespaceLower(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

// Per-session caches keyed by object identity. Reloaded sessions are new
// objects, so stale text never leaks (and old entries are GC-eligible).
const searchTextCache = new WeakMap<SessionInfo, string>();
const normalizedTextCache = new WeakMap<SessionInfo, string>();

// Cap the text length a user-supplied regex is executed against. Session
// `allMessagesText` can be very large, and a pathological pattern (e.g.
// `re:(a+)+$`) triggers catastrophic backtracking that synchronously freezes
// the TUI input/render loop on every keystroke. Bounding the input length
// keeps the worst-case match time linear-ish without changing results for
// realistic patterns (which match well within this window).
const REGEX_SEARCH_TEXT_CAP = 50_000;

// Total wall-clock budget for executing a user-supplied regex across ALL
// sessions in a single filtering pass. The per-session cap above bounds one
// match, but with many large sessions the cumulative cost per keystroke is
// N * cap and a pathological pattern can still backtrack for seconds, freezing
// the TUI input/render loop. Once this budget is exhausted within a pass, the
// remaining sessions skip the regex (treated as non-matching) so the loop
// always returns promptly. Realistic patterns finish well within this window.
const REGEX_FILTER_BUDGET_MS = 40;

function getSessionSearchText(session: SessionInfo): string {
	const cached = searchTextCache.get(session);
	if (cached !== undefined) return cached;
	const text = `${session.id} ${session.name ?? ""} ${session.allMessagesText} ${session.cwd}`;
	searchTextCache.set(session, text);
	return text;
}

function getSessionNormalizedText(session: SessionInfo, text: string): string {
	const cached = normalizedTextCache.get(session);
	if (cached !== undefined) return cached;
	const normalized = normalizeWhitespaceLower(text);
	normalizedTextCache.set(session, normalized);
	return normalized;
}

export function hasSessionName(session: SessionInfo): boolean {
	return Boolean(session.name?.trim());
}

function matchesNameFilter(session: SessionInfo, filter: NameFilter): boolean {
	if (filter === "all") return true;
	return hasSessionName(session);
}

export function parseSearchQuery(query: string): ParsedSearchQuery {
	const trimmed = query.trim();
	if (!trimmed) {
		return { mode: "tokens", tokens: [], regex: null };
	}

	// Regex mode: re:<pattern>
	if (trimmed.startsWith("re:")) {
		const pattern = trimmed.slice(3).trim();
		if (!pattern) {
			return { mode: "regex", tokens: [], regex: null, error: "Empty regex" };
		}
		try {
			return { mode: "regex", tokens: [], regex: new RegExp(pattern, "i") };
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return { mode: "regex", tokens: [], regex: null, error: msg };
		}
	}

	// Token mode with quote support.
	// Example: foo "node cve" bar
	const tokens: { kind: "fuzzy" | "phrase"; value: string }[] = [];
	let buf = "";
	let inQuote = false;
	let hadUnclosedQuote = false;

	const flush = (kind: "fuzzy" | "phrase"): void => {
		const v = buf.trim();
		buf = "";
		if (!v) return;
		tokens.push({ kind, value: v });
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]!;
		if (ch === '"') {
			if (inQuote) {
				flush("phrase");
				inQuote = false;
			} else {
				flush("fuzzy");
				inQuote = true;
			}
			continue;
		}

		if (!inQuote && /\s/.test(ch)) {
			flush("fuzzy");
			continue;
		}

		buf += ch;
	}

	if (inQuote) {
		hadUnclosedQuote = true;
	}

	// If quotes were unbalanced, fall back to plain whitespace tokenization.
	if (hadUnclosedQuote) {
		return {
			mode: "tokens",
			tokens: trimmed
				.split(/\s+/)
				.map((t) => t.trim())
				.filter((t) => t.length > 0)
				.map((t) => ({ kind: "fuzzy" as const, value: t })),
			regex: null,
		};
	}

	flush("fuzzy");

	return { mode: "tokens", tokens, regex: null };
}

export function matchSession(session: SessionInfo, parsed: ParsedSearchQuery, regexDeadline?: number): MatchResult {
	const text = getSessionSearchText(session);

	if (parsed.mode === "regex") {
		if (!parsed.regex) {
			return { matches: false, score: 0 };
		}
		// Total-pass budget exhausted: skip the (potentially catastrophic) regex
		// so the filtering loop returns promptly instead of freezing the TUI.
		if (regexDeadline !== undefined && Date.now() > regexDeadline) {
			return { matches: false, score: 0 };
		}
		const searchText = text.length > REGEX_SEARCH_TEXT_CAP ? text.slice(0, REGEX_SEARCH_TEXT_CAP) : text;
		const idx = searchText.search(parsed.regex);
		if (idx < 0) return { matches: false, score: 0 };
		return { matches: true, score: idx * 0.1 };
	}

	if (parsed.tokens.length === 0) {
		return { matches: true, score: 0 };
	}

	let totalScore = 0;
	let normalizedText: string | null = null;

	for (const token of parsed.tokens) {
		if (token.kind === "phrase") {
			if (normalizedText === null) {
				normalizedText = getSessionNormalizedText(session, text);
			}
			const phrase = normalizeWhitespaceLower(token.value);
			if (!phrase) continue;
			const idx = normalizedText.indexOf(phrase);
			if (idx < 0) return { matches: false, score: 0 };
			totalScore += idx * 0.1;
			continue;
		}

		const m = fuzzyMatch(token.value, text);
		if (!m.matches) return { matches: false, score: 0 };
		totalScore += m.score;
	}

	return { matches: true, score: totalScore };
}

export function filterAndSortSessions(
	sessions: SessionInfo[],
	query: string,
	sortMode: SortMode,
	nameFilter: NameFilter = "all",
): SessionInfo[] {
	const nameFiltered =
		nameFilter === "all" ? sessions : sessions.filter((session) => matchesNameFilter(session, nameFilter));
	const trimmed = query.trim();
	if (!trimmed) return nameFiltered;

	const parsed = parseSearchQuery(query);
	if (parsed.error) return [];

	// Cap total regex execution time across the whole pass so a pathological
	// user pattern can't synchronously freeze the TUI on every keystroke. Only
	// meaningful in regex mode; token mode is bounded by fuzzyMatch.
	const regexDeadline = parsed.mode === "regex" ? Date.now() + REGEX_FILTER_BUDGET_MS : undefined;

	// Recent mode: filter only, keep incoming order.
	if (sortMode === "recent") {
		const filtered: SessionInfo[] = [];
		for (const s of nameFiltered) {
			const res = matchSession(s, parsed, regexDeadline);
			if (res.matches) filtered.push(s);
		}
		return filtered;
	}

	// Relevance mode: sort by score, tie-break by modified desc.
	const scored: { session: SessionInfo; score: number }[] = [];
	for (const s of nameFiltered) {
		const res = matchSession(s, parsed, regexDeadline);
		if (!res.matches) continue;
		scored.push({ session: s, score: res.score });
	}

	scored.sort((a, b) => {
		if (a.score !== b.score) return a.score - b.score;
		return b.session.modified.getTime() - a.session.modified.getTime();
	});

	return scored.map((r) => r.session);
}
