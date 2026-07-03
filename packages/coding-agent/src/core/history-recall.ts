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
import { bm25Score, buildCorpus, computeDocStats, type DocStats, tokenize } from "./search/bm25.ts";
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
// Per-entry DocStats cache (BM25 tokenizer + scorer live in ./search/bm25.ts)
// ============================================================================

// Tokenizing a discarded entry is the dominant cost of a search and its result
// never changes: session entries are immutable objects (created once, never
// mutated) and getBranch() hands back the same references from the id map, so
// caching DocStats keyed by the entry object stays correct across queries. The
// discarded set only grows across a session (each compaction pushes more
// entries behind the window), so the cache never goes stale — it only warms.
// Keyed by reference: if an entry object is ever recreated the cache simply
// re-tokenizes it, which is correct by construction. WeakMap ⇒ entries GC'd
// when the session drops them.
const docStatsCache = new WeakMap<SessionMessageEntry, DocStats>();

function docStatsForEntry(entry: SessionMessageEntry): DocStats {
	const cached = docStatsCache.get(entry);
	if (cached) return cached;
	const stats = computeDocStats(messageSearchText(entry.message));
	docStatsCache.set(entry, stats);
	return stats;
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

	// Per-entry DocStats come from the cache (tokenized once, reused across
	// queries). df + avgLen are corpus-global and cheap, so recompute per query.
	const docs = entries.map(docStatsForEntry);
	const { avgLen, df } = buildCorpus(docs);

	const scored: HistoryHit[] = [];
	for (let i = 0; i < docs.length; i++) {
		const doc = docs[i];
		if (doc.length === 0) continue;
		const { score } = bm25Score(queryTokens, doc, avgLen, df, docs.length);
		if (score <= 0) continue;
		const entry = entries[i];
		// Re-extract the raw text only for a matching entry (the snippet source);
		// non-matches never pay for it, and matches are few (top-N).
		scored.push({
			entryId: entry.id,
			timestamp: entry.timestamp,
			role: entry.message.role,
			snippet: redactForDisk(headTailExcerpt(messageSearchText(entry.message), SNIPPET_MAX_CHARS)),
			score,
		});
	}

	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, Math.max(1, limit));
}
