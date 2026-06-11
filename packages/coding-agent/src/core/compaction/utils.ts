/**
 * Shared utilities for compaction and branch summarization.
 */

import type { AgentMessage } from "@pit/agent-core";
import type { Message } from "@pit/ai";

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

export type FileToolOp = "read" | "write" | "edit";

/**
 * Best-effort mapping from a (toolName, args) pair to a single file operation.
 * Returns undefined when the tool is not a file tool or when the path arg is
 * missing/empty. Shared between compaction's message extractor and the
 * real-time frequent-files tracker so both observers stay in lockstep.
 */
export function extractToolFileOp(toolName: string, args: unknown): { path: string; op: FileToolOp } | undefined {
	const op: FileToolOp | undefined =
		toolName === "read" ? "read" : toolName === "write" ? "write" : toolName === "edit" ? "edit" : undefined;
	if (!op) return undefined;
	if (typeof args !== "object" || args === null) return undefined;
	const path = (args as Record<string, unknown>).path;
	if (typeof path !== "string" || path.length === 0) return undefined;
	return { path, op };
}

/** Cap how many characters of an opaque operation argument we keep in the summary frame. */
const OP_PREVIEW_MAX_CHARS = 160;

function previewOpArg(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	const text = typeof value === "string" ? value : safeStringify(value);
	if (!text) return undefined;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (!collapsed) return undefined;
	if (collapsed.length <= OP_PREVIEW_MAX_CHARS) return collapsed;
	return `${collapsed.slice(0, OP_PREVIEW_MAX_CHARS)}…`;
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
		const path = typeof args.path === "string" ? args.path : undefined;

		switch (name) {
			case "read":
				if (path) addTo(fileOps.read, path);
				continue;
			case "write":
				if (path) addTo(fileOps.written, path);
				continue;
			case "edit":
				if (path) addTo(fileOps.edited, path);
				continue;
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
				const cmd =
					typeof args.command === "string" ? args.command : typeof args.cmd === "string" ? args.cmd : undefined;
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

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/** Fraction of the truncation budget kept from the head; the remainder is kept from the tail. */
const TRUNCATE_HEAD_FRACTION = 0.65;

/**
 * Truncate text to ~maxChars while preserving BOTH its head and its tail.
 *
 * Tool outputs frequently carry their most decisive signal at the end — a stack
 * trace's exception line, the last matches of a grep, a command's final status.
 * A head-only cut discards exactly that. Keeping a head+tail excerpt lets the
 * summarizer see the output's shape. This also mirrors `headTailExcerpt` in
 * compaction.ts (the pre-prune path): a large tool result the prune step already
 * shrank to head+tail is no longer re-truncated back to head-only here. Cuts snap
 * to line breaks for readability.
 */
function truncateForSummary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;

	const headBudget = Math.floor(maxChars * TRUNCATE_HEAD_FRACTION);
	const tailBudget = maxChars - headBudget;

	let head = text.slice(0, headBudget);
	const headNl = head.lastIndexOf("\n");
	if (headNl > headBudget - 200) head = head.slice(0, headNl);

	let tail = text.slice(text.length - tailBudget);
	const tailNl = tail.indexOf("\n");
	if (tailNl >= 0 && tailNl < 200) tail = tail.slice(tailNl + 1);

	const elided = text.length - head.length - tail.length;
	return `${head}\n\n[... ${elided} characters truncated ...]\n\n${tail}`;
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
	// First pass: collect parts with dedup metadata
	interface Part {
		text: string;
		/** Resource key for tool calls/results that can be deduped. */
		dedupKey?: string;
		/** true if this part is a tool result associated with the preceding tool call. */
		isToolResult?: boolean;
	}

	const parts: Part[] = [];
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
				parts.push({ text: `[User]: ${content}` });
				hasChainBreaker = true;
			}
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: { serialized: string; target: string | undefined; breaksChain: boolean }[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					const args = block.arguments as Record<string, unknown>;
					const argsStr = Object.entries(args)
						.map(([k, v]) => {
							const serialized = JSON.stringify(v);
							return serialized.length <= 300 ? `${k}=${serialized}` : `${k}=${serialized.slice(0, 300)}…`;
						})
						.join(", ");
					toolCalls.push({
						serialized: `${block.name}(${argsStr})`,
						target: getToolTarget(block.name, args),
						breaksChain: CHAIN_BREAKERS.has(block.name),
					});
				}
			}

			if (thinkingParts.length > 0) {
				const joined = thinkingParts.join("\n");
				const capped = joined.length <= 500 ? joined : `${joined.slice(0, 500)}…[truncated]`;
				parts.push({ text: `[Assistant thinking]: ${capped}` });
			}
			if (textParts.length > 0) {
				parts.push({ text: `[Assistant]: ${textParts.join("\n")}` });
			}
			if (toolCalls.length > 0) {
				if (toolCalls.some((tc) => tc.breaksChain)) hasChainBreaker = true;
				const target = toolCalls.length === 1 ? toolCalls[0].target : undefined;
				lastToolTarget = target;
				const dedupKey = target && !hasChainBreaker ? target : undefined;
				parts.push({
					text: `[Assistant tool calls]: ${toolCalls.map((tc) => tc.serialized).join("; ")}`,
					dedupKey,
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
					text: `[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`,
					dedupKey: lastToolTarget && !hasChainBreaker ? lastToolTarget : undefined,
					isToolResult: true,
				});
			}
			lastToolTarget = undefined;
		}
	}

	// Second pass: for each dedupKey, keep only the last occurrence pair (tool call + result)
	const lastSeen = new Map<string, number>();
	for (let i = parts.length - 1; i >= 0; i--) {
		const key = parts[i].dedupKey;
		if (key && !lastSeen.has(key)) {
			lastSeen.set(key, i);
		}
	}

	const result: string[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const key = part.dedupKey;
		if (key) {
			const lastIdx = lastSeen.get(key)!;
			if (part.isToolResult) {
				// Tool result: keep if its preceding tool call was kept
				const prevToolCallIdx = findPrecedingToolCall(parts, i);
				if (prevToolCallIdx !== -1 && prevToolCallIdx >= lastSeen.get(parts[prevToolCallIdx].dedupKey ?? "")!) {
					result.push(part.text);
				}
			} else if (i >= lastIdx) {
				result.push(part.text);
			}
		} else {
			result.push(part.text);
		}
	}

	return result.join("\n\n");
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
