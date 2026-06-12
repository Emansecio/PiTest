/**
 * Context compaction for long sessions.
 *
 * Pure functions for compaction logic. The session manager handles I/O,
 * and after compaction the session is reloaded.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { AgentMessage, StreamFn, ThinkingLevel } from "@pit/agent-core";
import type { AssistantMessage, Context, Model, SimpleStreamOptions, Usage } from "@pit/ai";
import { completeSimple } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { getCurrentDeferredOutputStore } from "../deferred-output-store.ts";
import {
	convertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "../messages.ts";
import { buildSessionContext, type CompactionEntry, type SessionEntry } from "../session-manager.ts";
import { crushJson } from "../tools/json-crush.ts";
import { buildFileDigests, formatFileDigests } from "./file-digests.ts";
import {
	computeOperationLists,
	createFileOps,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
} from "./utils.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

/** Details stored in CompactionEntry.details for structured summary frame.
 *
 * Older sessions only carry `readFiles` and `modifiedFiles`. The remaining
 * fields are populated by the structured summary frame and are loaded
 * defensively when present.
 */
export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
	searches?: string[];
	shellCmds?: string[];
	mcpCalls?: string[];
	/** path -> top symbols, derived at compaction time. Lossy guide; re-read for current content. */
	fileDigests?: Record<string, string>;
}

/**
 * Extract file operations from messages and previous compaction entries.
 */
function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	// Collect from previous compaction's details (if pi-generated)
	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromHook && prevCompaction.details) {
			// fromHook field kept for session file compatibility
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(f);
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
			if (Array.isArray(details.searches)) {
				for (const s of details.searches) fileOps.searches.add(s);
			}
			if (Array.isArray(details.shellCmds)) {
				for (const c of details.shellCmds) fileOps.shellCmds.add(c);
			}
			if (Array.isArray(details.mcpCalls)) {
				for (const c of details.mcpCalls) fileOps.mcpCalls.add(c);
			}
		}
	}

	// Extract from tool calls in messages
	for (const msg of messages) {
		extractFileOpsFromMessage(msg, fileOps);
	}

	return fileOps;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Extract AgentMessage from an entry if it produces one.
 * Returns undefined for entries that don't contribute to LLM context.
 *
 * NOTE: for `type === "message"` this returns `entry.message` BY REFERENCE — the
 * SAME object the live session context (buildSessionContext) pushes. Callers that
 * mutate the returned message (e.g. pruneOldToolOutputs) before a fallible step
 * must clone first; see `cloneToolResultMessagesForPrune`.
 */
function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	if (entry.type === "compaction") {
		return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
	}
	return undefined;
}

function getMessageFromEntryForCompaction(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "compaction") {
		return undefined;
	}
	return getMessageFromEntry(entry);
}

/** Result from compact() - SessionManager adds uuid/parentUuid when saving */
export interface CompactionResult<T = unknown> {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	/** Extension-specific data (e.g., ArtifactIndex, version markers for structured compaction) */
	details?: T;
}

// ============================================================================
// Types
// ============================================================================

export interface CompactionSettings {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
	/** Enable self-correction verification pass after summarization. Default: true */
	selfCorrection?: boolean;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
	enabled: true,
	reserveTokens: 16384,
	keepRecentTokens: 20000,
	selfCorrection: true,
};

// ============================================================================
// Token calculation
// ============================================================================

/**
 * Calculate total context tokens from usage.
 * Uses the native totalTokens field when available, falls back to computing from components.
 */
export function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * Get usage from an assistant message if available.
 * Skips aborted and error messages as they don't have valid usage data.
 */
function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

/**
 * Find the last non-aborted assistant message usage from session entries.
 */
export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export interface ContextUsageEstimate {
	tokens: number;
	usageTokens: number;
	trailingTokens: number;
	lastUsageIndex: number | null;
}

function getLastAssistantUsageInfo(messages: AgentMessage[]): { usage: Usage; index: number } | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const usage = getAssistantUsage(messages[i]);
		if (usage) return { usage, index: i };
	}
	return undefined;
}

/**
 * Estimate context tokens from messages, using the last assistant usage when available.
 * If there are messages after the last usage, estimate their tokens with estimateTokens.
 */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
	const usageInfo = getLastAssistantUsageInfo(messages);

	if (!usageInfo) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return {
			tokens: estimated,
			usageTokens: 0,
			trailingTokens: estimated,
			lastUsageIndex: null,
		};
	}

	const usageTokens = calculateContextTokens(usageInfo.usage);
	let trailingTokens = 0;
	for (let i = usageInfo.index + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}

	return {
		tokens: usageTokens + trailingTokens,
		usageTokens,
		trailingTokens,
		lastUsageIndex: usageInfo.index,
	};
}

/**
 * Compute a dynamic reserve that scales with context window size.
 * - Small windows (≤200k): 10% of window, or the configured reserve.
 * - Large windows (>200k): the configured reserve, a 20k floor, AND a 2.5%
 *   floor. The percentage floor matters for very large windows: a flat 20k on a
 *   1M window is only 2% (trigger at ~98%, dangerously close to the hard limit
 *   if the token estimate runs low); 2.5% keeps ~25k headroom (~97.5%), leaving
 *   slack for estimation error before the model rejects on overflow.
 */
export function computeDynamicReserve(contextWindow: number, configuredReserve: number): number {
	if (contextWindow > 200_000) {
		return Math.max(configuredReserve, 20_000, Math.ceil(contextWindow * 0.025));
	}
	return Math.max(configuredReserve, Math.floor(contextWindow * 0.1));
}

/** Hysteresis threshold: only re-compact if deficit grew by this many tokens since last compaction. */
const COALESCING_THRESHOLD_TOKENS = 8192;

/**
 * Check if compaction should trigger based on context usage.
 * Uses adaptive reserve scaling and hysteresis to avoid compaction churn.
 *
 * @param lastCompactionDeficit - deficit at last compaction trigger (0 if none). Callers
 *   should persist this value and pass it back on subsequent checks.
 */
export function shouldCompact(
	contextTokens: number,
	contextWindow: number,
	settings: CompactionSettings,
	lastCompactionDeficit = 0,
): boolean {
	if (!settings.enabled) return false;
	const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
	const threshold = contextWindow - reserve;
	if (contextTokens <= threshold) return false;
	const deficit = contextTokens - threshold;
	if (lastCompactionDeficit === 0) return true;
	return deficit > lastCompactionDeficit + COALESCING_THRESHOLD_TOKENS;
}

/**
 * Soft (predictive) trigger: fire compaction ~one `keepRecentTokens` window
 * BEFORE the hard threshold. Run in the background while the user reads the
 * just-finished turn, so the summary is ready before they send the next prompt
 * (no visible compaction wait). The hard `shouldCompact` stays as the
 * synchronous fallback for turns that jump straight past it.
 *
 * Returns false once at/over the hard threshold — there the caller must compact
 * synchronously, not defer.
 */
export function shouldCompactSoft(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
	if (!settings.enabled) return false;
	const reserve = computeDynamicReserve(contextWindow, settings.reserveTokens);
	const hardThreshold = contextWindow - reserve;
	if (contextTokens > hardThreshold) return false; // hard path owns this
	const softThreshold = hardThreshold - settings.keepRecentTokens;
	return softThreshold > 0 && contextTokens > softThreshold;
}

// ============================================================================
// Cut point detection
// ============================================================================

/** Chars-per-token ratios for content classification. */
const CHARS_PER_TOKEN_PROSE = 4;
const CHARS_PER_TOKEN_DENSE = 3.3;
/**
 * Non-latin scripts (CJK, Cyrillic, emoji, …) cost far more BPE tokens per
 * char than ASCII — roughly 0.5–2 tok/char. When the non-ASCII code-point
 * fraction exceeds this threshold, fall back to a denser divisor so the
 * estimate isn't wildly low (which would mislead findCutPoint / pruning).
 */
const CHARS_PER_TOKEN_NONLATIN = 2;
const NONLATIN_FRACTION_THRESHOLD = 0.3;
/** Token cost for an image block (kept as constant). */
const IMAGE_TOKENS = 1200;

/** Classified char counts for a message — imutável, logo cacheável. */
interface MessageCharCounts {
	dense: number;
	prose: number;
	images: number; // already in tokens (IMAGE_TOKENS per image)
}

const charCountCache = new WeakMap<AgentMessage, MessageCharCounts>();
const argsLengthCache = new WeakMap<object, number>();

function cachedArgsLength(args: unknown): number {
	if (typeof args === "object" && args !== null) {
		const cached = argsLengthCache.get(args);
		if (cached !== undefined) return cached;
		const len = JSON.stringify(args).length;
		argsLengthCache.set(args, len);
		return len;
	}
	return JSON.stringify(args).length;
}

/** Tool calls whose result lands on disk, so their argument bodies are redundant once old. */
const MUTATION_TOOL_NAMES = new Set(["write", "edit", "edit_v2", "ast_edit"]);
/** Min length for a tool-call arg STRING value to be worth eliding (keeps paths/flags intact). */
const TOOLCALL_ARG_VALUE_MARK_THRESHOLD = 200;

/**
 * Returns a deep copy of a mutation tool-call's arguments with long string
 * values (file bodies, edit oldText/newText) replaced by a short marker, plus
 * the number of chars elided. Short values (paths, flags) pass through. Returns
 * undefined when nothing was large enough to prune. The original object is never
 * mutated — callers reassign the returned copy onto a cloned tool-call block.
 */
function pruneToolCallArguments(args: unknown): { pruned: unknown; saved: number } | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	let saved = 0;
	const walk = (value: unknown): unknown => {
		if (typeof value === "string") {
			if (value.length <= TOOLCALL_ARG_VALUE_MARK_THRESHOLD) return value;
			saved += value.length;
			return `[${value.length} chars elided — applied to disk; the file is the source of truth]`;
		}
		if (Array.isArray(value)) return value.map(walk);
		if (typeof value === "object" && value !== null) {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) out[k] = walk(v);
			return out;
		}
		return value;
	};
	const pruned = walk(args);
	if (saved === 0) return undefined;
	return { pruned, saved };
}

/**
 * Classify text as dense (code/JSON/tool-output) or prose.
 * Dense: non-alphanumeric non-space char fraction > 0.20,
 * OR structural symbol density > 0.05.
 */
// Structural symbols counted by isDenseText, as char codes (precomputed once
// instead of an indexOf-scan over the 14-char string per character).
const STRUCTURAL_CODES = new Set<number>('{}[]()<>;:,="'.split("").map((c) => c.charCodeAt(0)));

function isDenseText(text: string): boolean {
	if (text.length === 0) return false;
	let nonAlphaNum = 0;
	let structural = 0;
	for (let i = 0; i < text.length; i++) {
		const cc = text.charCodeAt(i);
		// not whitespace: space(32) tab(9) lf(10) cr(13)
		if (cc !== 32 && cc !== 9 && cc !== 10 && cc !== 13) {
			const isAlnum = (cc >= 48 && cc <= 57) || (cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122);
			if (!isAlnum) nonAlphaNum++;
		}
		if (STRUCTURAL_CODES.has(cc)) structural++;
	}
	return nonAlphaNum / text.length > 0.2 || structural / text.length > 0.05;
}

/**
 * Estimate tokens for a raw text string, classifying it as dense or prose.
 * Exported for use in pruneOldToolOutputs and tests.
 */
export function estimateTextTokens(text: string, forceDense = false): number {
	if (text.length === 0) return 0;
	// Count non-ASCII code points (surrogate pairs counted once, so emoji = 1).
	let nonAscii = 0;
	let codePoints = 0;
	for (const ch of text) {
		codePoints++;
		const cp = ch.codePointAt(0);
		if (cp !== undefined && cp > 127) nonAscii++;
	}
	// Non-latin heavy text underestimates badly with the ASCII divisors; use a
	// denser ratio so the estimate stays close to real BPE token cost.
	if (codePoints > 0 && nonAscii / codePoints > NONLATIN_FRACTION_THRESHOLD) {
		return Math.ceil(text.length / CHARS_PER_TOKEN_NONLATIN);
	}
	const dense = forceDense || isDenseText(text);
	return Math.ceil(text.length / (dense ? CHARS_PER_TOKEN_DENSE : CHARS_PER_TOKEN_PROSE));
}

/** Count chars in a message, separated by density. Images stored as token count. */
function countMessageChars(message: AgentMessage): MessageCharCounts {
	const cached = charCountCache.get(message);
	if (cached !== undefined) return cached;

	const counts: MessageCharCounts = { dense: 0, prose: 0, images: 0 };

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				if (isDenseText(content)) counts.dense += content.length;
				else counts.prose += content.length;
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						if (isDenseText(block.text)) counts.dense += block.text.length;
						else counts.prose += block.text.length;
					}
				}
			}
			break;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					if (isDenseText(block.text)) counts.dense += block.text.length;
					else counts.prose += block.text.length;
				} else if (block.type === "thinking") {
					// thinking is usually prose
					if (isDenseText(block.thinking)) counts.dense += block.thinking.length;
					else counts.prose += block.thinking.length;
				} else if (block.type === "toolCall") {
					// tool name + JSON args — always dense
					counts.dense += block.name.length + cachedArgsLength(block.arguments);
				}
			}
			break;
		}
		case "custom":
		case "toolResult": {
			if (typeof message.content === "string") {
				// tool result text — always dense
				counts.dense += message.content.length;
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						// tool result text — always dense
						counts.dense += block.text.length;
					}
					if (block.type === "image") {
						counts.images += IMAGE_TOKENS;
					}
				}
			}
			break;
		}
		case "bashExecution": {
			// command + output — always dense
			counts.dense += message.command.length + message.output.length;
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			if (isDenseText(message.summary)) counts.dense += message.summary.length;
			else counts.prose += message.summary.length;
			break;
		}
	}

	charCountCache.set(message, counts);
	return counts;
}

/**
 * Estimate token count for a message using content-sensitive heuristics.
 * Dense content (code/JSON/tool output) uses ~3.3 chars/token;
 * prose uses ~4 chars/token. Images count as IMAGE_TOKENS each.
 * Results are cached per message object (messages are immutable once created).
 */
export function estimateTokens(message: AgentMessage): number {
	const counts = countMessageChars(message);
	return (
		Math.ceil(counts.prose / CHARS_PER_TOKEN_PROSE) + Math.ceil(counts.dense / CHARS_PER_TOKEN_DENSE) + counts.images
	);
}

/**
 * Find valid cut points: indices of user, assistant, custom, or bashExecution messages.
 * Never cut at tool results (they must follow their tool call).
 * When we cut at an assistant message with tool calls, its tool results follow it
 * and will be kept.
 * BashExecutionMessage is treated like a user message (user-initiated context).
 */
function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role;
				switch (role) {
					case "bashExecution":
					case "custom":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			// branch_summary and custom_message are user-role messages, valid cut points
			case "branch_summary":
			case "custom_message":
				cutPoints.push(i);
				break;
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "custom":
			case "label":
			case "session_info":
				break;
		}
	}
	return cutPoints;
}

/**
 * Find the user message (or bashExecution) that starts the turn containing the given entry index.
 * Returns -1 if no turn start found before the index.
 * BashExecutionMessage is treated like a user message for turn boundaries.
 */
export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		// branch_summary and custom_message are user-role messages, can start a turn
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	/** Index of first entry to keep */
	firstKeptEntryIndex: number;
	/** Index of user message that starts the turn being split, or -1 if not splitting */
	turnStartIndex: number;
	/** Whether this cut splits a turn (cut point is not a user message) */
	isSplitTurn: boolean;
}

/**
 * Find the cut point in session entries that keeps approximately `keepRecentTokens`.
 *
 * Algorithm: Walk backwards from newest, accumulating estimated message sizes.
 * Stop when we've accumulated >= keepRecentTokens. Cut at that point.
 *
 * Can cut at user OR assistant messages (never tool results). When cutting at an
 * assistant message with tool calls, its tool results come after and will be kept.
 *
 * Returns CutPointResult with:
 * - firstKeptEntryIndex: the entry index to start keeping from
 * - turnStartIndex: if cutting mid-turn, the user message that started that turn
 * - isSplitTurn: whether we're cutting in the middle of a turn
 *
 * Only considers entries between `startIndex` and `endIndex` (exclusive).
 */
export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	if (cutPoints.length === 0) {
		return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	// Walk backwards from newest, accumulating estimated message sizes
	let accumulatedTokens = 0;
	let cutIndex = cutPoints[0]; // Default: keep from first message (not header)

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;

		// Estimate this message's size
		const messageTokens = estimateTokens(entry.message);
		accumulatedTokens += messageTokens;

		// Check if we've exceeded the budget
		if (accumulatedTokens >= keepRecentTokens) {
			// Find the closest valid cut point at or after this entry
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					break;
				}
			}
			break;
		}
	}

	// Scan backwards from cutIndex to include any non-message entries (bash, settings, etc.)
	while (cutIndex > startIndex) {
		const prevEntry = entries[cutIndex - 1];
		// Stop at session header or compaction boundaries
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			// Stop if we hit any message
			break;
		}
		// Include this non-message entry (bash, settings change, etc.)
		cutIndex--;
	}

	// Determine if this is a split turn
	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

// ============================================================================
// Pre-pruning of old tool outputs
// ============================================================================

/** Token threshold above which old tool outputs are pruned before summarization. */
const PRUNE_TOKEN_THRESHOLD = 20_000;
/** Number of recent turns (user→assistant pairs) protected from pruning. */
const PRUNE_PROTECT_TURNS = 2;
/** Chars of the head/tail kept when shrinking a large tool output (see headTailExcerpt). */
const PRUNE_HEAD_CHARS = 1500;
const PRUNE_TAIL_CHARS = 800;

/**
 * Shrink a large tool output to its head + tail, eliding the middle. Keeps the
 * output's *shape* for the summarizer — first/last grep matches, a file's header
 * + footer, an error message + the tail of its stack — instead of a bare
 * "[pruned]" marker that tells the summarizer nothing. Cuts snap to line breaks
 * so excerpts stay readable.
 */
function headTailExcerpt(text: string): string {
	if (text.length <= PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS) return text;
	// Prefer a structural crush when the output is JSON/NDJSON: it keeps the
	// schema + head/tail samples + omitted counts at far fewer tokens than a
	// blind byte cut. Falls back to the head+tail excerpt below when not
	// applicable (not JSON, or won't fit even when fully collapsed).
	const crushed = crushJson(text, { targetChars: PRUNE_HEAD_CHARS + PRUNE_TAIL_CHARS });
	if (crushed !== undefined) return crushed;
	let head = text.slice(0, PRUNE_HEAD_CHARS);
	const headNl = head.lastIndexOf("\n");
	if (headNl > PRUNE_HEAD_CHARS - 400) head = head.slice(0, headNl);
	let tail = text.slice(text.length - PRUNE_TAIL_CHARS);
	const tailNl = tail.indexOf("\n");
	if (tailNl >= 0 && tailNl < 400) tail = tail.slice(tailNl + 1);
	const middle = text.slice(head.length, text.length - tail.length);
	const elided = estimateTextTokens(middle, true);
	return `${head}\n\n[… ~${elided} tokens elided …]\n\n${tail}`;
}

/**
 * Prune large tool result content from old messages before sending to the
 * summarizer. This reduces the input to the summarization LLM and produces
 * more focused summaries.
 *
 * Only tool results older than the last `protectTurns` user messages are
 * eligible. Tool results above `tokenThreshold` (estimated) are shrunk to a
 * head+tail excerpt (so the summarizer still sees the output's shape) — or,
 * when history deferral is enabled, persisted to disk with a recall placeholder.
 *
 * Mutates the passed messages and their text blocks in place. `getMessageFromEntry`
 * returns `entry.message` BY REFERENCE for `type === "message"` entries (the same
 * object the live session context holds), so callers that prune before a fallible
 * summarization (e.g. compact()) MUST pass cloned toolResult messages — see
 * `cloneToolResultMessagesForPrune` — otherwise an aborted compaction leaves the
 * live context with elided tool results and no restore path.
 */
export function pruneOldToolOutputs(
	messages: AgentMessage[],
	tokenThreshold = PRUNE_TOKEN_THRESHOLD,
	protectTurns = PRUNE_PROTECT_TURNS,
): number {
	// Find the index of the Nth-from-last user message to establish the protection boundary
	let userCount = 0;
	let protectFromIndex = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") {
			userCount++;
			if (userCount >= protectTurns) {
				protectFromIndex = i;
				break;
			}
		}
	}

	let prunedTokens = 0;

	const store = isTruthyEnvFlag(process.env.PIT_DEFER_HISTORY) ? getCurrentDeferredOutputStore() : undefined;

	for (let i = 0; i < protectFromIndex; i++) {
		const msg = messages[i];
		// Assistant tool-call args for mutation tools (write/edit) carry the full
		// file body / edit text. Once old, that body is redundant — the result
		// already landed on disk — yet it stays in context at full cost every turn
		// until summarization. Elide the heavy string values, keep paths/flags.
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (let b = 0; b < msg.content.length; b++) {
				const block = msg.content[b];
				if (block.type !== "toolCall" || !MUTATION_TOOL_NAMES.has(block.name)) continue;
				const before = estimateTextTokens(JSON.stringify(block.arguments), true);
				if (before <= tokenThreshold) continue;
				const result = pruneToolCallArguments(block.arguments);
				if (result) {
					(block as { arguments: unknown }).arguments = result.pruned;
					const after = estimateTextTokens(JSON.stringify(result.pruned), true);
					prunedTokens += Math.max(0, before - after);
				}
			}
			continue;
		}
		if (msg.role !== "toolResult") continue;
		if (!Array.isArray(msg.content)) continue;

		for (let b = 0; b < msg.content.length; b++) {
			const block = msg.content[b];
			if (block.type === "text" && block.text) {
				// Tool outputs are dense (JSON/code), use dense divisor
				const est = estimateTextTokens(block.text, true);
				if (est > tokenThreshold) {
					prunedTokens += est;
					if (store) {
						const id = store.put(block.text);
						(msg.content[b] as any).text =
							`[Tool output deferred (~${est} tokens) — id=${id}. Retrieve with recall_tool_output({ id: "${id}" }) if needed.]`;
					} else {
						// Keep the output's shape (head + tail) instead of discarding it.
						(msg.content[b] as any).text = headTailExcerpt(block.text);
					}
				}
			}
		}
	}

	return prunedTokens;
}

/**
 * Return a new message array where every `toolResult` message — and the
 * text-bearing content blocks inside it — is shallow-cloned, while all other
 * messages pass through by reference.
 *
 * `pruneOldToolOutputs` rewrites `block.text` in place. For `type === "message"`
 * entries, `getMessageFromEntry` hands back `entry.message` BY REFERENCE, so the
 * toolResult objects (and their content blocks) are the very ones the live
 * session context still points at. Cloning just the toolResult layer here means
 * the prune mutates throw-away copies: if summarization aborts after pruning, the
 * live context is untouched and no re-read/re-edit is needed. On the happy path
 * the produced summary is byte-identical — the clones carry the same text the
 * uncloned objects would have, the originals are simply discarded with the prep.
 *
 * Cloning also sidesteps the per-object `charCountCache` WeakMap: a fresh block
 * object cannot carry a stale cached char count from the pre-prune text.
 */
export function cloneToolResultMessagesForPrune(messages: AgentMessage[]): AgentMessage[] {
	return messages.map((msg) => {
		if (msg.role === "toolResult" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: msg.content.map((block) => (block.type === "text" ? { ...block } : block)),
			};
		}
		// Assistant tool-call blocks are reassigned a pruned `arguments` object by
		// pruneOldToolOutputs; shallow-clone the block so the live context's
		// arguments object is never swapped out under it.
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: msg.content.map((block) => (block.type === "toolCall" ? { ...block } : block)),
			};
		}
		return msg;
	});
}

// ============================================================================
// Summarization
// ============================================================================

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

function createSummarizationOptions(
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { maxTokens, signal, apiKey, headers };
	if (model.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	return options;
}

async function completeSummarization(
	model: Model<any>,
	context: Context,
	options: SimpleStreamOptions,
	streamFn?: StreamFn,
): Promise<AssistantMessage> {
	if (!streamFn) {
		return completeSimple(model, context, options);
	}
	const stream = await streamFn(model, context, options);
	return stream.result();
}

/**
 * Generate a summary of the conversation using the LLM.
 * If previousSummary is provided, uses the update prompt to merge.
 */
export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.8 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);

	// Use update prompt if we have a previous summary, otherwise initial prompt
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation to text so model doesn't try to continue it
	// Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
	const llmMessages = convertToLlm(currentMessages);
	const conversationText = serializeConversation(llmMessages);

	// Build the prompt with conversation wrapped in tags
	let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	return runSummarization(
		model,
		promptText,
		maxTokens,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		streamFn,
		"Summarization failed",
	);
}

function extractTextFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Run an LLM summarization pass: wrap the prompt in a single user message,
 * complete it, surface errors with the given label, and return the text.
 */
async function runSummarization(
	model: Model<any>,
	promptText: string,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn: StreamFn | undefined,
	errorLabel: string,
): Promise<string> {
	const summarizationMessages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	const response = await completeSummarization(
		model,
		{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
		createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
		streamFn,
	);

	if (response.stopReason === "error") {
		throw new Error(`${errorLabel}: ${response.errorMessage || "Unknown error"}`);
	}

	return extractTextFromResponse(response);
}

// ============================================================================
// Self-correction verification
// ============================================================================

const VERIFICATION_PROMPT = `Critically evaluate the context summary below. Did you omit any of the following from the original conversation?
- Exact file paths or line numbers
- Error messages or exception types
- Function/variable names
- User constraints or preferences
- Key decisions and their rationale

If anything is missing or could be more precise, produce a FINAL improved summary using the same format. Otherwise, repeat the summary exactly as-is.

<summary>
{SUMMARY}
</summary>`;

/**
 * Below this many summarized-input tokens, skip the self-correction pass. The
 * verification is a SECOND full LLM call per compaction; on small or incremental
 * compactions there is little content to omit, so the omission risk it guards
 * against is low and the cost is not justified. Large first-time compactions
 * (where dropping a file path / error / decision is likely) still verify.
 */
const VERIFY_MIN_INPUT_TOKENS = 25_000;

/** Sum content-aware token estimates across a message list. */
function sumMessageTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const message of messages) total += estimateTokens(message);
	return total;
}

/**
 * Run a self-correction pass on a generated summary. A second LLM call
 * evaluates the summary for omissions and produces a corrected version.
 * Falls back to the original if the corrected version inflates token count
 * by more than 10%.
 */
async function verifySummary(
	summary: string,
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn?: StreamFn,
): Promise<string> {
	const promptText = VERIFICATION_PROMPT.replace("{SUMMARY}", summary);
	const messages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: promptText }],
			timestamp: Date.now(),
		},
	];

	try {
		const response = await completeSummarization(
			model,
			{ systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages },
			createSummarizationOptions(model, maxTokens, apiKey, headers, signal, thinkingLevel),
			streamFn,
		);

		if (response.stopReason === "error") {
			return summary;
		}

		const corrected = extractTextFromResponse(response);
		if (!corrected.trim()) return summary;

		const originalTokens = Math.ceil(summary.length / 4);
		const correctedTokens = Math.ceil(corrected.length / 4);
		if (correctedTokens > originalTokens * 1.1) {
			return summary;
		}

		return corrected;
	} catch {
		return summary;
	}
}

// ============================================================================
// Compaction Preparation (for extensions)
// ============================================================================

export interface CompactionPreparation {
	/** UUID of first entry to keep */
	firstKeptEntryId: string;
	/** Messages that will be summarized and discarded */
	messagesToSummarize: AgentMessage[];
	/** Messages that will be turned into turn prefix summary (if splitting) */
	turnPrefixMessages: AgentMessage[];
	/** Whether this is a split turn (cut point in middle of turn) */
	isSplitTurn: boolean;
	tokensBefore: number;
	/** Summary from previous compaction, for iterative update */
	previousSummary?: string;
	/** File operations extracted from messagesToSummarize */
	fileOps: FileOperations;
	/** Compaction settions from settings.jsonl	*/
	settings: CompactionSettings;
	/** Working directory — used to strip path prefixes in summaries, saving tokens. */
	cwd?: string;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type === "compaction") {
			prevCompactionIndex = i;
			break;
		}
	}

	let previousSummary: string | undefined;
	let boundaryStart = 0;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		const firstKeptEntryIndex = pathEntries.findIndex((entry) => entry.id === prevCompaction.firstKeptEntryId);
		boundaryStart = firstKeptEntryIndex >= 0 ? firstKeptEntryIndex : prevCompactionIndex + 1;
	}
	const boundaryEnd = pathEntries.length;

	const tokensBefore = estimateContextTokens(buildSessionContext(pathEntries).messages).tokens;

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, settings.keepRecentTokens);

	// Get UUID of first kept entry
	const firstKeptEntry = pathEntries[cutPoint.firstKeptEntryIndex];
	if (!firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = firstKeptEntry.id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	// Messages to summarize (will be discarded after summary)
	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntryForCompaction(pathEntries[i]);
		if (msg) messagesToSummarize.push(msg);
	}

	// Messages for turn prefix summary (if splitting a turn)
	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntryForCompaction(pathEntries[i]);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	// Extract file operations from messages and previous compaction
	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	// Also extract file ops from turn prefix if splitting
	if (cutPoint.isSplitTurn) {
		for (const msg of turnPrefixMessages) {
			extractFileOpsFromMessage(msg, fileOps);
		}
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
	};
}

// ============================================================================
// Main compaction function
// ============================================================================

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/**
 * Generate summaries for compaction using prepared data.
 * Returns CompactionResult - SessionManager adds uuid/parentUuid when saving.
 *
 * @param preparation - Pre-calculated preparation from prepareCompaction()
 * @param customInstructions - Optional custom focus for the summary
 */
export async function compact(
	preparation: CompactionPreparation,
	model: Model<any>,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	customInstructions?: string,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize: messagesToSummarizeRaw,
		turnPrefixMessages: turnPrefixMessagesRaw,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		fileOps,
		settings,
		cwd,
	} = preparation;

	// Clone toolResult messages BEFORE pruning. getMessageFromEntry returns
	// entry.message by reference for 'message' entries, so without this the prune
	// would elide tool results inside the LIVE session context; an aborted
	// summarization would then leave them elided with no restore. Cloning makes the
	// prune operate on throw-away copies — happy-path output is unchanged.
	const messagesToSummarize = cloneToolResultMessagesForPrune(messagesToSummarizeRaw);
	const turnPrefixMessages = isSplitTurn
		? cloneToolResultMessagesForPrune(turnPrefixMessagesRaw)
		: turnPrefixMessagesRaw;

	// Pre-prune large tool outputs before sending to summarizer. Scale the
	// threshold to the window: tighter windows prune more aggressively (capped at
	// the default so large windows are unchanged).
	const pruneThreshold = Math.min(
		PRUNE_TOKEN_THRESHOLD,
		Math.max(4_000, Math.floor((model.contextWindow || 200_000) * 0.1)),
	);
	pruneOldToolOutputs(messagesToSummarize, pruneThreshold);
	if (isSplitTurn) {
		pruneOldToolOutputs(turnPrefixMessages, pruneThreshold);
	}

	// Generate summaries (can be parallel if both needed) and merge into one
	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0
				? generateSummary(
						messagesToSummarize,
						model,
						settings.reserveTokens,
						apiKey,
						headers,
						signal,
						customInstructions,
						previousSummary,
						thinkingLevel,
						streamFn,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(
				turnPrefixMessages,
				model,
				settings.reserveTokens,
				apiKey,
				headers,
				signal,
				thinkingLevel,
				streamFn,
			),
		]);
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else {
		summary = await generateSummary(
			messagesToSummarize,
			model,
			settings.reserveTokens,
			apiKey,
			headers,
			signal,
			customInstructions,
			previousSummary,
			thinkingLevel,
			streamFn,
		);
	}

	// Self-correction: verify summary for omitted details. Gated by input size —
	// small/incremental compactions skip the second LLM call (low omission risk).
	const verifyInputTokens =
		sumMessageTokens(messagesToSummarize) + (isSplitTurn ? sumMessageTokens(turnPrefixMessages) : 0);
	if (settings.selfCorrection !== false && verifyInputTokens >= VERIFY_MIN_INPUT_TOKENS) {
		const maxTokens = Math.min(
			Math.floor(0.8 * settings.reserveTokens),
			model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
		);
		summary = await verifySummary(summary, model, maxTokens, apiKey, headers, signal, thinkingLevel, streamFn);
	}

	// Compute structured operation lists and append to summary (paths stripped of cwd)
	const lists = computeOperationLists(fileOps, cwd);
	summary += formatFileOperations(lists);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no UUID - session may need migration");
	}

	const details: CompactionDetails = {
		readFiles: lists.readFiles,
		modifiedFiles: lists.modifiedFiles,
	};
	if (lists.searches.length > 0) details.searches = lists.searches;
	if (lists.shellCmds.length > 0) details.shellCmds = lists.shellCmds;
	if (lists.mcpCalls.length > 0) details.mcpCalls = lists.mcpCalls;

	// File digests: a symbol outline of touched files at compaction time, so the
	// post-compaction model recalls the CURRENT shape of what it worked on without a
	// re-read. Modified files are the artifact trail that summary prose silently
	// drops, so they get digests by default; read-only files stay behind
	// PIT_FILE_DIGESTS to bound prefix growth. The lists are disjoint (read AND
	// modified surfaces only in modifiedFiles), so concatenating needs no dedup.
	const digestPaths = isTruthyEnvFlag(process.env.PIT_FILE_DIGESTS)
		? [...lists.modifiedFiles, ...lists.readFiles]
		: lists.modifiedFiles;
	if (digestPaths.length > 0) {
		const digests = await buildFileDigests(digestPaths, async (p) => {
			try {
				return await readFile(isAbsolute(p) ? p : resolve(cwd ?? ".", p), "utf8");
			} catch {
				return null;
			}
		});
		if (Object.keys(digests).length > 0) {
			details.fileDigests = digests;
			summary += `\n${formatFileDigests(digests)}`;
		}
	}

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details,
	};
}

/**
 * Generate a summary for a turn prefix (when splitting a turn).
 */
async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model<any>,
	reserveTokens: number,
	apiKey: string | undefined,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel?: ThinkingLevel,
	streamFn?: StreamFn,
): Promise<string> {
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	); // Smaller budget for turn prefix
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	return runSummarization(
		model,
		promptText,
		maxTokens,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		streamFn,
		"Turn prefix summarization failed",
	);
}
