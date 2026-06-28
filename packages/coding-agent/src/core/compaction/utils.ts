/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@pit/agent-core";
import type { Message } from "@pit/ai";
import { sliceSafe } from "../../utils/surrogate.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import { redactForDisk } from "../secret-redactor.ts";
import type { SessionEntry } from "../session-manager.ts";
import { extractPathArg } from "../tools/argument-prep.ts";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
	/** grep/glob/search queries observed in the compaction window. */
	searches: Set<string>;
	/** Shell command strings observed (bash tool). */
	shellCmds: Set<string>;
	/** MCP tool calls observed, formatted as `serverName.toolName` when both are knowable. */
	mcpCalls: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
		searches: new Set(),
		shellCmds: new Set(),
		mcpCalls: new Set(),
	};
}

/**
 * Structured operation lists persisted in a summary entry's `details`. Both
 * compaction (`CompactionDetails`) and branch summarization (`BranchSummaryDetails`)
 * carry exactly these fields; compaction extends it with `fileDigests`. Older
 * sessions may only have `readFiles`/`modifiedFiles`, so every array is read
 * defensively (the merge below `Array.isArray`-guards each).
 */
export interface SummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
	searches?: string[];
	shellCmds?: string[];
	mcpCalls?: string[];
}

/**
 * Merge a previous summary entry's persisted `details` lists back into a live
 * {@link FileOperations} accumulator (cumulative cross-compaction tracking).
 * `readFiles`→read, `modifiedFiles`→edited, plus searches/shellCmds/mcpCalls.
 * Every field is `Array.isArray`-guarded for sessions written before the field
 * existed. Identical merge previously hand-inlined in compaction's
 * `extractFileOperations` and branch summarization's `prepareBranchEntries`.
 */
export function mergeSummaryDetailsIntoFileOps(details: SummaryDetails, fileOps: FileOperations): void {
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

export type FileToolOp = "read" | "write" | "edit";

const FILE_TOOL_OPS: Record<string, FileToolOp> = {
	read: "read",
	write: "write",
	edit: "edit",
};

const BASH_COMMAND_KEYS = ["command", "cmd"] as const;

function pickBashCommand(args: Record<string, unknown>): string | undefined {
	for (const key of BASH_COMMAND_KEYS) {
		const value = args[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

/**
 * Best-effort mapping from a (toolName, args) pair to a single file operation.
 * Returns undefined when the tool is not a file tool or when the path arg is
 * missing/empty. Shared between compaction's message extractor and the
 * real-time frequent-files tracker so both observers stay in lockstep.
 */
export function extractToolFileOp(toolName: string, args: unknown): { path: string; op: FileToolOp } | undefined {
	const op = FILE_TOOL_OPS[toolName];
	if (!op) return undefined;
	if (typeof args !== "object" || args === null) return undefined;
	const path = extractPathArg(args as Record<string, unknown>);
	if (path === undefined || path.length === 0) return undefined;
	return { path, op };
}

/** Cap how many characters of an opaque operation argument we keep in the summary frame. */
const OP_PREVIEW_MAX_CHARS = 160;

function previewOpArg(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = typeof value === "string" ? value : safeStringify(value);
	if (!text) return undefined;
	// Redact at the SOURCE: a secret in a shell command or search pattern would
	// otherwise reach every summary sink verbatim (session JSONL, hindsight bank,
	// any future sink). file-digests already redact at source; this closes the
	// shell/search gap. Respects the PIT_NO_SECRET_REDACT kill-switch.
	const collapsed = redactForDisk(text.replace(/\s+/g, " ").trim());
	if (!collapsed) return undefined;
	if (collapsed.length <= OP_PREVIEW_MAX_CHARS) return collapsed;
	return `${sliceSafe(collapsed, 0, OP_PREVIEW_MAX_CHARS)}…`;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant") return;
	if (!("content" in message) || !Array.isArray(message.content)) return;

	// Defensive add: tolerate partial FileOperations objects from legacy callers
	// that only initialized the original read/written/edited sets.
	const addTo = (set: Set<string> | undefined, value: string): void => {
		if (set) set.add(value);
	};

	for (const block of message.content) {
		if (typeof block !== "object" || block === null) continue;
		if (!("type" in block) || block.type !== "toolCall") continue;
		if (!("arguments" in block) || !("name" in block)) continue;

		const args = (block.arguments as Record<string, unknown> | undefined) ?? {};
		const name = block.name as string;
		const fileOp = extractToolFileOp(name, args);
		if (fileOp) {
			if (fileOp.op === "read") addTo(fileOps.read, fileOp.path);
			else if (fileOp.op === "write") addTo(fileOps.written, fileOp.path);
			else addTo(fileOps.edited, fileOp.path);
			continue;
		}

		switch (name) {
			case "grep":
			case "glob":
			case "search": {
				const pattern =
					typeof args.pattern === "string"
						? args.pattern
						: typeof args.query === "string"
							? args.query
							: undefined;
				const preview = previewOpArg(pattern);
				if (preview) addTo(fileOps.searches, preview);
				continue;
			}
			case "bash":
			case "shell":
			case "exec": {
				const cmd = pickBashCommand(args);
				const preview = previewOpArg(cmd);
				if (preview) addTo(fileOps.shellCmds, preview);
				continue;
			}
		}

		// MCP tool calls follow the convention `mcp__<server>__<tool>`.
		if (name.startsWith("mcp__")) {
			const rest = name.slice("mcp__".length);
			const sepIdx = rest.indexOf("__");
			const label = sepIdx === -1 ? rest : `${rest.slice(0, sepIdx)}.${rest.slice(sepIdx + 2)}`;
			addTo(fileOps.mcpCalls, label);
		}
	}
}

/**
 * Strip the working directory prefix from a path, returning a shorter relative form.
 * Falls back to the original if the path is not under cwd.
 */
function stripCwdPrefix(filePath: string, cwd: string | undefined): string {
	if (!cwd) return filePath;
	const normalizedPath = filePath.replace(/\\/g, "/");
	const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
	if (normalizedPath.startsWith(`${normalizedCwd}/`)) {
		return normalizedPath.slice(normalizedCwd.length + 1);
	}
	return filePath;
}

/**
 * Cap on how many entries per operation category survive into the summary frame.
 * The fileOps Sets accumulate across compactions (each compaction re-merges the
 * previous compaction's details), so unique entries grow without bound and ride
 * along in the prefix of every request. Keeping only the {@link MAX_OPS_PER_CATEGORY}
 * most-recent per category bounds that cost. Sets preserve insertion order, so the
 * tail is the most recently observed.
 */
const MAX_OPS_PER_CATEGORY = 30;

/**
 * Take the last {@link MAX_OPS_PER_CATEGORY} elements from a string iterable
 * (insertion order = recency for our Sets). Returns fewer when the source is
 * smaller, so realistic small windows are unchanged.
 */
function tailCap(values: Iterable<string>): string[] {
	const all = [...values];
	return all.length <= MAX_OPS_PER_CATEGORY ? all : all.slice(all.length - MAX_OPS_PER_CATEGORY);
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 * Paths are stripped of the cwd prefix when provided.
 *
 * Each category is capped to the {@link MAX_OPS_PER_CATEGORY} most-recent entries
 * (tail of insertion order) BEFORE sorting, so unbounded accumulation across
 * compactions does not bloat the summary frame.
 */
export function computeFileLists(
	fileOps: FileOperations,
	cwd?: string,
): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set([...fileOps.edited, ...fileOps.written]);
	const readOnly = tailCap([...fileOps.read].filter((f) => !modified.has(f))).sort();
	const modifiedFiles = tailCap(modified).sort();
	if (!cwd) return { readFiles: readOnly, modifiedFiles };
	return {
		readFiles: readOnly.map((f) => stripCwdPrefix(f, cwd)),
		modifiedFiles: modifiedFiles.map((f) => stripCwdPrefix(f, cwd)),
	};
}

/** Extended lists captured by the structured summary frame. */
export interface OperationLists {
	readFiles: string[];
	modifiedFiles: string[];
	searches: string[];
	shellCmds: string[];
	mcpCalls: string[];
}

/**
 * Compute all structured operation lists in one pass. Existing file-list semantics
 * are preserved: a file that appears in both read and modified surfaces only in
 * modifiedFiles.
 *
 * Tolerates partial {@link FileOperations} objects: callers (e.g. legacy
 * extension code) that initialized only the read/written/edited sets still
 * receive valid (empty) lists for the structured fields.
 */
export function computeOperationLists(fileOps: FileOperations, cwd?: string): OperationLists {
	const { readFiles, modifiedFiles } = computeFileLists(fileOps, cwd);
	// Cap each category to the most-recent entries (tail of insertion order) before
	// sorting, mirroring computeFileLists, so the lists do not grow without bound.
	const toSorted = (set: Set<string> | undefined): string[] => (set ? tailCap(set).sort() : []);
	return {
		readFiles,
		modifiedFiles,
		searches: toSorted(fileOps.searches),
		shellCmds: toSorted(fileOps.shellCmds),
		mcpCalls: toSorted(fileOps.mcpCalls),
	};
}

/**
 * Format file operations as XML tags for summary.
 *
 * Backwards-compatible overload: the 2-argument form preserves the original
 * read-files/modified-files-only frame used by previous compaction snapshots.
 * Callers wanting the full structured summary frame (with searches, shell
 * commands, and MCP calls) should pass an {@link OperationLists} object.
 */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string;
export function formatFileOperations(lists: OperationLists): string;
export function formatFileOperations(arg1: string[] | OperationLists, modifiedFiles?: string[]): string {
	const lists: OperationLists = Array.isArray(arg1)
		? { readFiles: arg1, modifiedFiles: modifiedFiles ?? [], searches: [], shellCmds: [], mcpCalls: [] }
		: arg1;

	const sections: string[] = [];
	if (lists.readFiles.length > 0) {
		sections.push(`<read-files>\n${lists.readFiles.join("\n")}\n</read-files>`);
	}
	if (lists.modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${lists.modifiedFiles.join("\n")}\n</modified-files>`);
	}
	if (lists.searches.length > 0) {
		sections.push(`<searches>\n${lists.searches.join("\n")}\n</searches>`);
	}
	if (lists.shellCmds.length > 0) {
		sections.push(`<shell-commands>\n${lists.shellCmds.join("\n")}\n</shell-commands>`);
	}
	if (lists.mcpCalls.length > 0) {
		sections.push(`<mcp-calls>\n${lists.mcpCalls.join("\n")}\n</mcp-calls>`);
	}
	if (sections.length === 0) return "";
	return `\n\n${sections.join("\n\n")}`;
}

/** Approximate chars per token for summary output trimming (matches bench scripts). */
const SUMMARY_CHARS_PER_TOKEN = 3.7;

/**
 * Strip prose lines that duplicate structured operation lists (C2). File paths,
 * searches, and shell commands are appended as XML via {@link formatFileOperations};
 * repeating them in LLM prose wastes summarizer output tokens.
 */
export function trimSummaryProseAgainstOperations(summary: string, lists: OperationLists): string {
	if (!summary.trim()) return summary;
	const pathSet = new Set([...lists.readFiles, ...lists.modifiedFiles]);
	const searchSet = new Set(lists.searches);
	const shellSet = new Set(lists.shellCmds);
	const mcpSet = new Set(lists.mcpCalls);

	const out: string[] = [];
	for (const line of summary.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			out.push(line);
			continue;
		}
		const bullet = trimmed.replace(/^[-*]\s*(?:\[[xX ]\]\s*)?/, "").trim();
		const candidates = [trimmed, bullet];
		const backtick = trimmed.match(/^`([^`]+)`$/);
		if (backtick) candidates.push(backtick[1]);
		const bulletBacktick = bullet.match(/^`([^`]+)`$/);
		if (bulletBacktick) candidates.push(bulletBacktick[1]);
		let duplicate = false;
		for (const c of candidates) {
			if (pathSet.has(c) || searchSet.has(c) || shellSet.has(c) || mcpSet.has(c)) {
				duplicate = true;
				break;
			}
		}
		if (!duplicate) {
			for (const p of pathSet) {
				if (bullet === p || (bullet.endsWith(p) && bullet.length - p.length <= 24)) {
					duplicate = true;
					break;
				}
			}
		}
		if (!duplicate) out.push(line);
	}
	return out.join("\n").replace(/\n{4,}/g, "\n\n\n");
}

/** Estimate summarizer output tokens saved by {@link trimSummaryProseAgainstOperations}. */
export function estimateSummaryTrimSavedChars(before: string, lists: OperationLists): number {
	const after = trimSummaryProseAgainstOperations(before, lists);
	return Math.max(0, before.length - after.length);
}

/** Token estimate from char count (bench-aligned). */
export function estimateCharsAsTokens(chars: number): number {
	return Math.round(chars / SUMMARY_CHARS_PER_TOKEN);
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/** Tighter tool-result cap for incremental (delta) summarization input. */
const DELTA_TOOL_RESULT_MAX_CHARS = 1200;

/** Max chars per string arg in delta JSON tool calls (edit oldText/newText). */
const DELTA_ARG_STRING_MAX = 160;

/**
 * Maximum characters for assistant thinking in serialized summaries. A head-only
 * cut amputated the conclusion — the decision the SUMMARIZATION prompt asks for
 * ("Key Decisions") lives at the END of the reasoning. Use a head+tail excerpt so
 * the final decision survives.
 */
/** Max chars for assistant thinking in live context and serialized summaries. */
export const THINKING_MAX_CHARS = 1500;

/** Fraction of the truncation budget kept from the head; the remainder is kept from the tail. */
const TRUNCATE_HEAD_FRACTION = 0.65;

/**
 * Cap assistant thinking to head+tail excerpt for wire/summarization (A4).
 * Preserves the conclusion at the tail — decisions live at the end of reasoning.
 */
export function capThinkingForContext(text: string): string {
	return truncateForSummary(text, THINKING_MAX_CHARS);
}

export interface HeadTailExcerptOptions {
	/** Chars kept from the head before snapping to a line break. */
	headBudget: number;
	/** Chars kept from the tail before snapping to a line break. */
	tailBudget: number;
	/** A head/tail line-break snap is taken only when it lands within this many chars of the budget edge. */
	snapWindow: number;
	/**
	 * Builds the elision marker placed between head and tail. Receives the count
	 * of elided chars and the raw elided middle (so callers can report tokens
	 * instead of chars). The returned string is inserted verbatim with a blank
	 * line on each side.
	 */
	marker: (elidedChars: number, middle: string) => string;
	/**
	 * When set, attempt a structural JSON/NDJSON crush to this char budget BEFORE
	 * the head+tail cut; if it produces output, that is returned instead. Omit to
	 * skip the crush path entirely.
	 */
	crush?: (text: string) => string | undefined;
}

/**
 * Shrink text to a head + tail excerpt, eliding the middle, while preserving the
 * output's *shape* for a summarizer — first/last grep matches, a file's header +
 * footer, an error message + the tail of its stack. Tool outputs frequently carry
 * their most decisive signal at the end (a stack trace's exception line, a
 * command's final status); a head-only cut discards exactly that. Cuts snap to
 * line breaks for readability.
 *
 * Returns `text` unchanged when it already fits within `headBudget + tailBudget`.
 * Shared by the compaction pre-prune path (`headTailExcerpt`, token-count marker,
 * crushJson enabled) and the serialization path (`truncateForSummary`,
 * char-count marker, no crush) — they only differ in the option values, so the
 * two excerpts stay byte-identical to their previous hand-rolled forms.
 */
export function headTailExcerpt(text: string, options: HeadTailExcerptOptions): string {
	const { headBudget, tailBudget, snapWindow, marker, crush } = options;
	if (text.length <= headBudget + tailBudget) return text;

	if (crush) {
		const crushed = crush(text);
		if (crushed !== undefined) return crushed;
	}

	let head = text.slice(0, headBudget);
	const headNl = head.lastIndexOf("\n");
	if (headNl > headBudget - snapWindow) head = head.slice(0, headNl);

	let tail = text.slice(text.length - tailBudget);
	const tailNl = tail.indexOf("\n");
	if (tailNl >= 0 && tailNl < snapWindow) tail = tail.slice(tailNl + 1);

	const middle = text.slice(head.length, text.length - tail.length);
	return `${head}\n\n${marker(middle.length, middle)}\n\n${tail}`;
}

/**
 * Truncate text to ~maxChars while preserving BOTH its head and its tail.
 * Thin wrapper over {@link headTailExcerpt} using the serialization-path budgets
 * (65/35 split, 200-char snap, char-count marker, no JSON crush).
 */
function truncateForSummary(text: string, maxChars: number): string {
	const headBudget = Math.floor(maxChars * TRUNCATE_HEAD_FRACTION);
	return headTailExcerpt(text, {
		headBudget,
		tailBudget: maxChars - headBudget,
		snapWindow: 200,
		marker: (elidedChars) => `[... ${elidedChars} characters truncated ...]`,
	});
}

/**
 * Extract the primary resource target from a tool call for dedup purposes.
 * Returns undefined for tools that don't operate on a single identifiable resource.
 */
function getToolTarget(name: string, args: Record<string, unknown>): string | undefined {
	switch (name) {
		case "read":
		case "write":
		case "edit":
			return typeof args.path === "string"
				? `file:${args.path}`
				: typeof args.file === "string"
					? `file:${args.file}`
					: undefined;
		case "grep":
		case "find":
		case "glob":
			return typeof args.pattern === "string" ? `search:${args.pattern}` : undefined;
		default:
			return undefined;
	}
}

/** Tools that break the dedup chain — their presence means prior ops on the same resource are semantically distinct. */
const CHAIN_BREAKERS = new Set(["bash", "shell", "exec"]);

type ConversationPartKind = "user" | "assistant" | "thinking" | "toolCall" | "toolResult";

interface ConversationPart {
	kind: ConversationPartKind;
	/** Resource key for tool calls/results that can be deduped. */
	dedupKey?: string;
	/** true if this part is a tool result associated with the preceding tool call. */
	isToolResult?: boolean;
	userText?: string;
	assistantText?: string;
	thinkingText?: string;
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
	toolResult?: { name: string; text: string; isError: boolean };
}

function compactArgsForDelta(args: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (typeof value === "string" && value.length > DELTA_ARG_STRING_MAX) {
			out[key] = `${sliceSafe(value, 0, DELTA_ARG_STRING_MAX)}…`;
		} else {
			out[key] = value;
		}
	}
	return out;
}

function collectConversationParts(messages: Message[], includeThinking: boolean): ConversationPart[] {
	const parts: ConversationPart[] = [];
	let lastToolTarget: string | undefined;
	let hasChainBreaker = false;

	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join("");
			if (content) {
				parts.push({ kind: "user", userText: content });
				hasChainBreaker = true;
			}
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: Array<{
				name: string;
				args: Record<string, unknown>;
				target: string | undefined;
				breaksChain: boolean;
			}> = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					toolCalls.push({
						name: block.name,
						args,
						target: getToolTarget(block.name, args),
						breaksChain: CHAIN_BREAKERS.has(block.name),
					});
				}
			}

			if (includeThinking && thinkingParts.length > 0) {
				const joined = thinkingParts.join("\n");
				parts.push({ kind: "thinking", thinkingText: capThinkingForContext(joined) });
			}
			if (textParts.length > 0) {
				parts.push({ kind: "assistant", assistantText: textParts.join("\n") });
			}
			if (toolCalls.length > 0) {
				if (toolCalls.some((tc) => tc.breaksChain)) hasChainBreaker = true;
				const target = toolCalls.length === 1 ? toolCalls[0].target : undefined;
				lastToolTarget = target;
				const dedupKey = target && !hasChainBreaker ? target : undefined;
				parts.push({
					kind: "toolCall",
					dedupKey,
					toolCalls: toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
				});
				if (dedupKey) hasChainBreaker = false;
			}
		} else if (msg.role === "toolResult") {
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("");
			if (content) {
				parts.push({
					kind: "toolResult",
					dedupKey: lastToolTarget && !hasChainBreaker ? lastToolTarget : undefined,
					isToolResult: true,
					toolResult: {
						name: msg.toolName ?? "tool",
						text: content,
						isError: msg.isError === true,
					},
				});
			}
			lastToolTarget = undefined;
		}
	}

	return parts;
}

function dedupeConversationParts(parts: ConversationPart[]): ConversationPart[] {
	const lastSeen = new Map<string, number>();
	for (let i = parts.length - 1; i >= 0; i--) {
		const key = parts[i].dedupKey;
		if (key && !lastSeen.has(key)) {
			lastSeen.set(key, i);
		}
	}

	const result: ConversationPart[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const key = part.dedupKey;
		if (key) {
			const lastIdx = lastSeen.get(key)!;
			if (part.isToolResult) {
				const prevToolCallIdx = findPrecedingToolCall(parts, i);
				if (prevToolCallIdx !== -1 && prevToolCallIdx >= lastSeen.get(parts[prevToolCallIdx].dedupKey ?? "")!) {
					result.push(part);
				}
			} else if (i >= lastIdx) {
				result.push(part);
			}
		} else {
			result.push(part);
		}
	}
	return result;
}

function renderConversationProse(parts: ConversationPart[]): string {
	const lines: string[] = [];
	for (const part of parts) {
		if (part.kind === "user" && part.userText) {
			lines.push(`[User]: ${part.userText}`);
		} else if (part.kind === "thinking" && part.thinkingText) {
			lines.push(`[Assistant thinking]: ${part.thinkingText}`);
		} else if (part.kind === "assistant" && part.assistantText) {
			lines.push(`[Assistant]: ${part.assistantText}`);
		} else if (part.kind === "toolCall" && part.toolCalls) {
			const serialized = part.toolCalls
				.map((tc) => {
					const argsStr = Object.entries(tc.args)
						.map(([k, v]) => {
							const encoded = JSON.stringify(v);
							return encoded.length <= 300 ? `${k}=${encoded}` : `${k}=${sliceSafe(encoded, 0, 300)}…`;
						})
						.join(", ");
					return `${tc.name}(${argsStr})`;
				})
				.join("; ");
			lines.push(`[Assistant tool calls]: ${serialized}`);
		} else if (part.kind === "toolResult" && part.toolResult) {
			lines.push(`[Tool result]: ${truncateForSummary(part.toolResult.text, TOOL_RESULT_MAX_CHARS)}`);
		}
	}
	return lines.join("\n\n");
}

type DeltaEvent =
	| { k: "u"; t: string }
	| { k: "a"; t: string }
	| { k: "c"; n: string; a: Record<string, unknown> }
	| { k: "r"; n: string; t: string; e?: 1 };

function renderConversationDelta(parts: ConversationPart[]): string {
	const events: DeltaEvent[] = [];
	for (const part of parts) {
		if (part.kind === "user" && part.userText) {
			events.push({ k: "u", t: part.userText });
		} else if (part.kind === "assistant" && part.assistantText) {
			events.push({ k: "a", t: part.assistantText });
		} else if (part.kind === "toolCall" && part.toolCalls) {
			for (const tc of part.toolCalls) {
				events.push({ k: "c", n: tc.name, a: compactArgsForDelta(tc.args) });
			}
		} else if (part.kind === "toolResult" && part.toolResult) {
			const event: DeltaEvent = {
				k: "r",
				n: part.toolResult.name,
				t: truncateForSummary(part.toolResult.text, DELTA_TOOL_RESULT_MAX_CHARS),
			};
			if (part.toolResult.isError) event.e = 1;
			events.push(event);
		}
	}
	return JSON.stringify(events);
}

/**
 * Serialize LLM messages to text for summarization.
 * This prevents the model from treating it as a conversation to continue.
 * Call convertToLlm() first to handle custom message types.
 *
 * Consecutive operations on the same resource are deduplicated: only the last
 * tool call + result per resource survives, unless a shell command or user
 * message intervenes (breaking the chain). Inspired by Ned's trim_context_summary.
 *
 * Tool results are truncated to keep the summarization request within
 * reasonable token budgets. Full content is not needed for summarization.
 */
export function serializeConversation(messages: Message[]): string {
	const parts = collectConversationParts(messages, true);
	return renderConversationProse(dedupeConversationParts(parts));
}

/**
 * Compact JSON serialization for incremental (2nd+) compaction summarization.
 * Omits thinking blocks and uses shorter keys/truncation — prior reasoning lives
 * in `<previous-summary>`. Same resource dedup as {@link serializeConversation}.
 */
export function serializeConversationDelta(messages: Message[]): string {
	const parts = collectConversationParts(messages, false);
	return renderConversationDelta(dedupeConversationParts(parts));
}

function findPrecedingToolCall(parts: Array<{ dedupKey?: string; isToolResult?: boolean }>, resultIdx: number): number {
	for (let i = resultIdx - 1; i >= 0; i--) {
		if (parts[i].dedupKey && !parts[i].isToolResult) return i;
		if (!parts[i].dedupKey && !parts[i].isToolResult) break;
	}
	return -1;
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

// ============================================================================
// Entry to Message Conversion
// ============================================================================

export interface GetMessageFromEntryOptions {
	/** Skip `toolResult` messages — their context lives in the assistant tool call (branch summarization). */
	skipToolResults?: boolean;
	/** Return undefined for `compaction` entries instead of their summary message (compaction history pass). */
	skipCompaction?: boolean;
}

/**
 * Extract an {@link AgentMessage} from a session entry, or undefined for entries
 * that don't contribute to LLM context.
 *
 * NOTE: for `type === "message"` this returns `entry.message` BY REFERENCE — the
 * SAME object the live session context (buildSessionContext) pushes. Callers that
 * mutate the returned message (e.g. pruneOldToolOutputs) before a fallible step
 * must clone first; see `cloneToolResultMessagesForPrune`.
 *
 * Options select the two pre-existing variants: branch summarization skips
 * `toolResult` entries (`skipToolResults`); compaction's history walk skips
 * `compaction` entries (`skipCompaction`). With no options the behavior matches
 * compaction's base `getMessageFromEntry`.
 */
export function getMessageFromEntry(
	entry: SessionEntry,
	options: GetMessageFromEntryOptions = {},
): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			if (options.skipToolResults && entry.message.role === "toolResult") return undefined;
			return entry.message;
		case "custom_message":
			return createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp);
		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
		case "compaction":
			if (options.skipCompaction) return undefined;
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp);
		default:
			return undefined;
	}
}
