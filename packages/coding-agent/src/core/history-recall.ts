/**
 * Recall history — recover details from the compacted-away conversation window.
 *
 * Compaction drops pre-`firstKeptEntryId` messages from the LLM context but the
 * entries stay intact in the session JSONL. `recall_history` BM25-searches those
 * discarded entries so the post-compaction model can RECOVER a fact (a file
 * path, an error, a decision) instead of HALLUCINATING one. Same philosophy as
 * `recall_tool_output` (deferred tool outputs), generalized to conversation
 * history.
 *
 * Pure + session-scoped: the tool reads the live branch via a module-global
 * source the AgentSession publishes on boot and clears on dispose (mirrors
 * `deferred-output-store.ts`). No JSONL re-read — the in-memory branch is the
 * source of truth. Snippets are redacted with `redactForDisk` before they
 * return to the model.
 */

import type { AgentMessage } from "@pit/agent-core";
import { sliceSafe, truncateWithEllipsis } from "../utils/surrogate.ts";
import { redactForDisk } from "./secret-redactor.ts";
import { getLatestCompactionEntry, type SessionEntry, type SessionMessageEntry } from "./session-manager.ts";

// ============================================================================
// Module-global session source (mirrors deferred-output-store.ts)
// ============================================================================

let currentSource: (() => SessionEntry[]) | undefined;

export function setCurrentHistoryRecallSource(fn: (() => SessionEntry[]) | undefined): void {
	currentSource = fn;
}

export function getCurrentHistoryRecallSource(): (() => SessionEntry[]) | undefined {
	return currentSource;
}

// ============================================================================
// Discarded-entry collection
// ============================================================================

/**
 * Entries BEFORE the latest compaction's `firstKeptEntryId` — the window the
 * model can no longer see but `recall_history` can search. Filters to
 * `type === "message"` (user/assistant/toolResult/custom/bashExecution), the
 * carriers of recallable content. Returns `[]` when there is no compaction.
 */
export function collectDiscardedEntries(branch: SessionEntry[]): SessionMessageEntry[] {
	const compaction = getLatestCompactionEntry(branch);
	if (!compaction) return [];
	const idx = branch.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
	if (idx <= 0) return [];
	return branch.slice(0, idx).filter((entry): entry is SessionMessageEntry => entry.type === "message");
}

// ============================================================================
// Text extraction + snippet shaping
// ============================================================================

/** Cap on a tool-call argument preview included in the searchable text. */
const ARG_PREVIEW_MAX_CHARS = 200;
/** Cap on a returned hit's snippet (head+tail). */
const SNIPPET_MAX_CHARS = 700;
const SNIPPET_HEAD_FRACTION = 0.6;

/** Loose content shape shared by user/toolResult/custom message variants. */
type LooseContent = string | Array<{ type: string; text?: string }>;

/** Join the text blocks of a string-or-blocks content payload (ignores images/etc). */
function textBlocksToText(content: LooseContent): string {
	if (typeof content === "string") return content;
	return content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");
}

/**
 * Best-effort text extraction from a message for BM25 indexing. Covers the
 * roles a compacted window carries: user, assistant (text + tool calls +
 * thinking), toolResult, custom, and bashExecution. Tool-call args are
 * previewed (capped) so a `read`/`edit` path or a `grep` pattern is searchable
 * without indexing a full file body.
 */
function messageSearchText(message: AgentMessage): string {
	switch (message.role) {
		case "user":
			return textBlocksToText(message.content as LooseContent);
		case "assistant": {
			const parts: string[] = [];
			for (const block of message.content) {
				if (block.type === "text") parts.push(block.text);
				else if (block.type === "thinking") parts.push(block.thinking);
				else if (block.type === "toolCall") {
					parts.push(block.name);
					try {
						parts.push(truncateWithEllipsis(JSON.stringify(block.arguments), ARG_PREVIEW_MAX_CHARS));
					} catch {
						// ignore non-serializable args
					}
				}
			}
			return parts.join("\n");
		}
		case "toolResult":
			return textBlocksToText(message.content as LooseContent);
		case "custom":
			return textBlocksToText(message.content as LooseContent);
		case "bashExecution":
			return `${message.command}\n${message.output}`;
		default:
			return "";
	}
}

/** Head + tail excerpt preserving the start (goal/constraint) and end (result/error). */
function headTailExcerpt(text: string, max: number): string {
	if (text.length <= max) return text;
	const headBudget = Math.floor(max * SNIPPET_HEAD_FRACTION);
	const tailBudget = max - headBudget;
	const head = sliceSafe(text, 0, headBudget);
	const tail = sliceSafe(text, text.length - tailBudget);
	return `${head}\n…\n${tail}`;
}

// ============================================================================
// BM25 (k1=1.5, b=0.75) — inlined; no shared BM25 helper exists in the repo
// ============================================================================

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

interface DocStats {
	index: number;
	length: number;
	termFreq: Map<string, number>;
}

function buildDocStats(texts: string[]): { docs: DocStats[]; avgLen: number; df: Map<string, number> } {
	const docs: DocStats[] = [];
	const df = new Map<string, number>();
	let total = 0;
	for (let i = 0; i < texts.length; i++) {
		const tokens = tokenize(texts[i]);
		const termFreq = new Map<string, number>();
		for (const tok of tokens) {
			termFreq.set(tok, (termFreq.get(tok) ?? 0) + 1);
		}
		for (const tok of termFreq.keys()) {
			df.set(tok, (df.get(tok) ?? 0) + 1);
		}
		docs.push({ index: i, length: tokens.length, termFreq });
		total += tokens.length;
	}
	const avgLen = docs.length > 0 ? total / docs.length : 0;
	return { docs, avgLen, df };
}

function bm25Score(
	queryTokens: string[],
	doc: DocStats,
	avgLen: number,
	df: Map<string, number>,
	totalDocs: number,
): number {
	const k1 = 1.5;
	const b = 0.75;
	let score = 0;
	for (const term of queryTokens) {
		const tf = doc.termFreq.get(term);
		if (!tf) continue;
		const dfTerm = df.get(term) ?? 0;
		const idf = Math.log(1 + (totalDocs - dfTerm + 0.5) / (dfTerm + 0.5));
		const norm = avgLen > 0 ? doc.length / avgLen : 1;
		const denom = tf + k1 * (1 - b + b * norm);
		score += idf * ((tf * (k1 + 1)) / Math.max(denom, 1e-9));
	}
	return score;
}

// ============================================================================
// Public search
// ============================================================================

export interface HistoryHit {
	entryId: string;
	timestamp: string;
	role: string;
	snippet: string;
	score: number;
}

/**
 * BM25-search the discarded entries for `query`, returning the top `limit`
 * hits with redacted, head+tail-shaped snippets. Entries with no searchable
 * text are skipped (they cannot match). Returns `[]` when there is nothing to
 * search.
 */
export function searchDiscardedHistory(entries: SessionMessageEntry[], query: string, limit = 5): HistoryHit[] {
	if (entries.length === 0) return [];
	const queryTokens = tokenize(query);
	if (queryTokens.length === 0) return [];

	const texts = entries.map((entry) => messageSearchText(entry.message));
	const { docs, avgLen, df } = buildDocStats(texts);

	const scored: HistoryHit[] = [];
	for (let i = 0; i < docs.length; i++) {
		const doc = docs[i];
		if (doc.length === 0) continue;
		const score = bm25Score(queryTokens, doc, avgLen, df, docs.length);
		if (score <= 0) continue;
		const entry = entries[i];
		scored.push({
			entryId: entry.id,
			timestamp: entry.timestamp,
			role: entry.message.role,
			snippet: redactForDisk(headTailExcerpt(texts[i], SNIPPET_MAX_CHARS)),
			score,
		});
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, Math.max(1, limit));
}
