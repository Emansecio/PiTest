/**
 * Branch summarization for tree navigation.
 *
 * When navigating to a different point in the session tree, this generates
 * a summary of the branch being left so context isn't lost.
 */

import type { AgentMessage } from "@pit/agent-core";
import type { Model } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { convertToLlm } from "../messages.ts";
import type { ReadonlySessionManager, SessionEntry } from "../session-manager.ts";
import {
	buildVerificationSource,
	runSummarizationWithStatus,
	sumMessageTokens,
	summarizationMaxTokens,
	VERIFY_MIN_INPUT_TOKENS,
	verifySummary,
} from "./compaction.ts";
import { groundSummaryPaths } from "./summary-grounding.ts";
import {
	computeOperationLists,
	createFileOps,
	estimateCharsAsTokens,
	extractFileOpsFromMessage,
	type FileOperations,
	formatFileOperations,
	getMessageFromEntry,
	mergeSummaryDetailsIntoFileOps,
	type SummaryDetails,
	serializeConversation,
	serializedMessageChars,
} from "./utils.ts";

// ============================================================================
// Types
// ============================================================================

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	searches?: string[];
	shellCmds?: string[];
	mcpCalls?: string[];
	aborted?: boolean;
	error?: string;
}

/**
 * Details stored in BranchSummaryEntry.details for the structured summary frame.
 * Identical to the shared {@link SummaryDetails} (compaction extends the same
 * type with file digests).
 */
export type BranchSummaryDetails = SummaryDetails;

export type { FileOperations } from "./utils.ts";

export interface BranchPreparation {
	/** Messages extracted for summarization, in chronological order */
	messages: AgentMessage[];
	/** File operations extracted from tool calls */
	fileOps: FileOperations;
	/** Total estimated tokens in messages */
	totalTokens: number;
}

export interface CollectEntriesResult {
	/** Entries to summarize, in chronological order */
	entries: SessionEntry[];
	/** Common ancestor between old and new position, if any */
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	/** Model to use for summarization */
	model: Model<any>;
	/** API key for the model */
	apiKey: string;
	/** Request headers for the model */
	headers?: Record<string, string>;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Optional custom instructions for summarization */
	customInstructions?: string;
	/** If true, customInstructions replaces the default prompt instead of being appended */
	replaceInstructions?: boolean;
	/** Tokens reserved for prompt + LLM response (default 16384) */
	reserveTokens?: number;
	/** Working directory — used to strip path prefixes in summaries, saving tokens. */
	cwd?: string;
	/** When false, skip the extra verification LLM pass (default true, mirrors compaction.selfCorrection). */
	selfCorrection?: boolean;
}

// ============================================================================
// Entry Collection
// ============================================================================

/**
 * Collect entries that should be summarized when navigating from one position to another.
 *
 * Walks from oldLeafId back to the common ancestor with targetId, collecting entries
 * along the way. Does NOT stop at compaction boundaries - those are included and their
 * summaries become context.
 *
 * @param session - Session manager (read-only access)
 * @param oldLeafId - Current position (where we're navigating from)
 * @param targetId - Target position (where we're navigating to)
 * @returns Entries to summarize and the common ancestor
 */
export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	// If no old position, nothing to summarize
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	// Find common ancestor (deepest node that's on both paths)
	const oldPath = new Set(session.getBranch(oldLeafId).map((e) => e.id));
	const targetPath = session.getBranch(targetId);

	// targetPath is root-first, so iterate backwards to find deepest common ancestor
	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	// Collect entries from old leaf back to common ancestor
	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	while (current && current !== commonAncestorId) {
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	// Reverse to get chronological order
	entries.reverse();

	return { entries, commonAncestorId };
}

// ============================================================================
// Entry to Message Conversion
// ============================================================================

// Entry → AgentMessage conversion now lives in ./utils.ts as the shared
// getMessageFromEntry. The branch summarizer skips tool-result messages (their
// context is in the assistant's tool call), selected via { skipToolResults: true }.

/**
 * Estimate an entry's contribution to the branch-summary token budget over the
 * SERIALIZED prose form the summary prompt actually consumes (M16).
 *
 * generateBranchSummary builds its prompt with {@link serializeConversation},
 * which caps tool-call args, thinking, and tool-result text. The raw per-message
 * token estimate charges the full uncapped length, so a single big write/edit
 * body or long reasoning turn filled the window many times over its real prompt
 * cost, and the window covered far less history than it could. Measuring the
 * serialized length keeps the budget consistent with the prompt.
 *
 * Returns 0 for messages that don't serialize into the prompt (e.g. display-only
 * inter-agent relays that {@link convertToLlm} drops).
 */
function estimateSerializedBranchTokens(message: AgentMessage): number {
	const llm = convertToLlm([message]);
	if (llm.length === 0) return 0;
	return estimateCharsAsTokens(serializedMessageChars(llm[0]));
}

/**
 * Prepare entries for summarization with token budget.
 *
 * Walks entries from NEWEST to OLDEST, adding messages until we hit the token budget.
 * This ensures we keep the most recent context when the branch is too long.
 *
 * Also collects file operations from:
 * - Tool calls in assistant messages
 * - Existing branch_summary entries' details (for cumulative tracking)
 *
 * @param entries - Entries in chronological order
 * @param tokenBudget - Maximum tokens to include (0 = no limit)
 */
export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	let totalTokens = 0;

	// First pass: collect file ops from ALL entries (even if they don't fit in token budget)
	// This ensures we capture cumulative file tracking from nested branch summaries
	// Only extract from pi-generated summaries (fromHook !== true), not extension-generated ones
	for (const entry of entries) {
		if (entry.type === "branch_summary" && !entry.fromHook && entry.details) {
			mergeSummaryDetailsIntoFileOps(entry.details as BranchSummaryDetails, fileOps);
		}
	}

	// Second pass: walk from newest to oldest, adding messages until token budget
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		// Skip tool results — their context is in the assistant's tool call.
		const message = getMessageFromEntry(entry, { skipToolResults: true });
		if (!message) continue;

		// Extract file ops from assistant messages (tool calls)
		extractFileOpsFromMessage(message, fileOps);

		// M16: budget each entry by its SERIALIZED size (the prompt caps tool-call
		// args, thinking, and tool-result text) rather than the raw estimate, so the
		// window covers the history it can actually afford, not the pre-cap bulk.
		const tokens = estimateSerializedBranchTokens(message);

		// Check budget before adding
		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			// If this is a summary entry, try to fit it anyway as it's important context
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.push(message);
					totalTokens += tokens;
				}
			}
			// Stop - we've hit the budget
			break;
		}

		messages.push(message);
		totalTokens += tokens;
	}

	messages.reverse();

	return { messages, fileOps, totalTokens };
}

// ============================================================================
// Summary Generation
// ============================================================================

const BRANCH_SUMMARY_PREAMBLE = `The user explored a different conversation branch before returning here.
Summary of that exploration:

`;

const BRANCH_SUMMARY_PROMPT = `Create a structured summary of this conversation branch for context when returning later.

Use this EXACT format:

## Goal
[What was the user trying to accomplish in this branch?]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Work that was started but not finished]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [What should happen next to continue this work]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/**
 * Generate a summary of abandoned branch entries.
 *
 * @param entries - Session entries to summarize (chronological order)
 * @param options - Generation options
 */
export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const { model, apiKey, headers, signal, customInstructions, replaceInstructions, reserveTokens = 16384 } = options;

	// Token budget = context window minus reserved space for prompt + response
	const contextWindow = model.contextWindow || 128000;
	const tokenBudget = contextWindow - reserveTokens;

	const { messages, fileOps } = prepareBranchEntries(entries, tokenBudget);

	if (messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	// Transform to LLM-compatible messages, then serialize to text
	// Serialization prevents the model from treating it as a conversation to continue
	const llmMessages = convertToLlm(messages);
	const conversationText = serializeConversation(llmMessages);

	// Build prompt
	let instructions: string;
	if (replaceInstructions && customInstructions) {
		instructions = customInstructions;
	} else if (customInstructions) {
		instructions = `${BRANCH_SUMMARY_PROMPT}\n\nAdditional focus: ${customInstructions}`;
	} else {
		instructions = BRANCH_SUMMARY_PROMPT;
	}
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;

	// Derive the output cap from reserveTokens (the space held back for the
	// response), mirroring compaction's generateSummary instead of a fixed 2048
	// that silently truncated large structured summaries. 0.5× because the branch
	// summary prompt is explicitly concise; capped by the model's own maxTokens.
	const maxTokens = Math.min(
		Math.floor(0.5 * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
	// Call LLM via the shared summarization runner (no streamFn / reasoning here),
	// preserving the aborted-vs-error distinction this caller surfaces separately.
	const outcome = await runSummarizationWithStatus(
		model,
		promptText,
		maxTokens,
		apiKey,
		headers,
		signal,
		undefined,
		undefined,
	);

	// Check if aborted or errored
	if (outcome.status === "aborted") {
		return { aborted: true };
	}
	if (outcome.status === "error") {
		return { error: outcome.errorMessage || "Summarization failed" };
	}

	// C7/E16: reuse compaction's verify + grounding passes on the generated prose
	// before deterministic framing (preamble + operation lists). Fail-open — a
	// thrown verify/ground must not break tree navigation.
	const lists = computeOperationLists(fileOps, options.cwd);
	let prose = outcome.text;
	const originalProse = prose;
	try {
		const verifyInputTokens = sumMessageTokens(messages);
		const selfCorrection = options.selfCorrection !== false;
		if (selfCorrection && verifyInputTokens >= VERIFY_MIN_INPUT_TOKENS) {
			const verifySource = buildVerificationSource(messages, []);
			const verifyMaxTokens = summarizationMaxTokens(model, reserveTokens, 0.8);
			prose = await verifySummary(
				prose,
				verifySource,
				model,
				verifyMaxTokens,
				apiKey,
				headers,
				signal,
				undefined,
				undefined,
			);
		}
		if (!isTruthyEnvFlag(process.env.PIT_NO_SUMMARY_GROUNDING)) {
			prose = groundSummaryPaths(prose, lists, options.cwd).summary;
		}
	} catch {
		prose = originalProse;
	}

	// Prepend preamble to provide context about the branch summary
	let summary = BRANCH_SUMMARY_PREAMBLE + prose;

	// Append structured operation lists (paths stripped of cwd)
	summary += formatFileOperations(lists);

	const result: BranchSummaryResult = {
		summary: summary || "No summary generated",
		readFiles: lists.readFiles,
		modifiedFiles: lists.modifiedFiles,
	};
	if (lists.searches.length > 0) result.searches = lists.searches;
	if (lists.shellCmds.length > 0) result.shellCmds = lists.shellCmds;
	if (lists.mcpCalls.length > 0) result.mcpCalls = lists.mcpCalls;
	return result;
}
