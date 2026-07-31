/**
 * Compaction summarization.
 *
 * Summarization prompts, LLM summary generation (plain and cache-aware),
 * serialized windows, and the self-correction verify pass.
 * Extracted from compaction.ts (deep-modules decomposition); public surface
 * is re-exported from compaction.ts so existing importers are unaffected.
 */

import type { AgentMessage, StreamFn, ThinkingLevel } from "@pit/agent-core";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions } from "@pit/ai";
import { CHARS_PER_TOKEN_PROSE, completeSimple, estimateStringTokens, recordDiagnostic } from "@pit/ai";
import { isTruthyEnvFlag } from "../../utils/env-flags.ts";
import { convertToLlm } from "../messages.ts";
import { type CacheAwareGeneration, decideCacheAwareRoute } from "./cache-aware.ts";
import { estimateTokens } from "./message-tokens.ts";
import {
	headTailExcerpt as headTailExcerptShared,
	normalizeStructuredSummaryOutput,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversation,
	serializeConversationDelta,
} from "./utils.ts";

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

## Corrections (self-check)
- [FINAL STEP: re-scan the conversation above for material facts the sections you just wrote omitted — exact file paths, error messages, function/variable names, user constraints, key decisions. List each omitted fact as one bullet, VERBATIM from the conversation. NEVER add facts that are not in the conversation. OMIT this entire section when nothing is missing.]

Keep each section concise. Preserve exact file paths, function names, and error messages.

STRUCTURED-PRIMARY (output economy): File paths, searches, shell commands, and MCP calls are appended automatically as structured XML tags after your summary. Do NOT list them in prose — focus prose on intent, decisions, blockers, and next steps only. Keep each section to 1–3 bullets max.`;

const SUMMARIZATION_JSON_PROMPT = `The messages above are a conversation to summarize. Produce a JSON context checkpoint another LLM will use to continue the work.

Your final assistant message MUST be a single fenced \`\`\`json\`\`\` block matching this schema (no markdown sections, no prose outside the fence):
{
  "goal": ["string"],
  "constraints": ["string"],
  "done": ["completed items — omit [x] prefix"],
  "inProgress": ["current work — omit [ ] prefix"],
  "blocked": ["blockers or empty array"],
  "keyDecisions": ["Decision: rationale"],
  "nextSteps": ["ordered strings"],
  "criticalContext": ["data/refs needed to continue or empty array"],
  "corrections": ["material facts the fields above omitted — optional; empty when nothing is missing"]
}

Keep each array to 1–3 items max. Do NOT list file paths, searches, shell commands, or MCP calls — they are appended as structured XML after parsing.

SELF-CHECK (final step): before emitting, re-scan the conversation for omitted exact file paths, error messages, function/variable names, user constraints, or key decisions and put each in "corrections" VERBATIM from the source. NEVER invent facts; leave "corrections" empty when nothing is missing.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

When the new messages are inside <conversation-delta>, they are a compact JSON array of events:
[{"k":"u","t":"user text"},{"k":"a","t":"assistant text"},{"k":"c","n":"toolName","a":{args}},{"k":"r","n":"toolName","t":"result excerpt","e":1}]
Keys: u=user, a=assistant, c=tool call, r=tool result (e=1 only on error). Thinking is omitted — use <previous-summary> for prior reasoning.

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

## Corrections (self-check)
- [FINAL STEP: re-scan the new messages for material facts the sections you just wrote omitted — exact file paths, error messages, function/variable names, user constraints, key decisions. List each omitted fact as one bullet, VERBATIM from the source. NEVER invent facts. OMIT this entire section when nothing is missing.]

Keep each section concise. Preserve exact file paths, function names, and error messages.

STRUCTURED-PRIMARY (output economy): Do NOT duplicate file paths, searches, or shell commands in prose — they are appended as structured XML. Update intent/decisions/blockers only; 1–3 bullets per section.`;

const UPDATE_SUMMARIZATION_JSON_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

When the new messages are inside <conversation-delta>, they are a compact JSON array of events:
[{"k":"u","t":"user text"},{"k":"a","t":"assistant text"},{"k":"c","n":"toolName","a":{args}},{"k":"r","n":"toolName","t":"result excerpt","e":1}]
Keys: u=user, a=assistant, c=tool call, r=tool result (e=1 only on error). Thinking is omitted — use <previous-summary> for prior reasoning.

Merge new information into the checkpoint. PRESERVE prior goals/decisions unless obsolete; UPDATE progress and next steps.

Your final assistant message MUST be a single fenced \`\`\`json\`\`\` block matching this schema (no markdown, no prose outside the fence):
{
  "goal": ["string"],
  "constraints": ["string"],
  "done": ["completed items"],
  "inProgress": ["current work"],
  "blocked": ["blockers"],
  "keyDecisions": ["Decision: rationale"],
  "nextSteps": ["ordered strings"],
  "criticalContext": ["refs needed"],
  "corrections": ["material facts the fields above omitted — optional; empty when nothing is missing"]
}

Keep each array to 1–3 items. Do NOT list file paths, searches, or shell commands — appended as structured XML after parsing.

SELF-CHECK (final step): before emitting, re-scan the new messages for omitted exact file paths, error messages, function/variable names, constraints, or key decisions and put each in "corrections" VERBATIM from the source. NEVER invent facts; leave "corrections" empty when nothing is missing.`;

function summarizationUsesJsonOutput(): boolean {
	return !isTruthyEnvFlag(process.env.PIT_NO_STRUCTURED_SUMMARY_OUTPUT);
}

/**
 * Lazy memo of the two serialized views of an immutable message window:
 * `llm` (convertToLlm) and `delta` (serializeConversationDelta over `llm`).
 * generateSummary and buildVerificationSource both consume the SAME window;
 * without the memo each recomputes convertToLlm + delta over identical
 * messages. Getters are lazy so the structural-only path pays nothing.
 *
 * The window messages MUST be immutable for the object's lifetime — in
 * compact() that means creating it AFTER pruneOldToolOutputs (which rewrites
 * block.text in place).
 */
export interface SerializedWindow {
	readonly llm: Message[];
	readonly delta: string;
}

export function createSerializedWindow(messages: AgentMessage[]): SerializedWindow {
	let llm: Message[] | undefined;
	let delta: string | undefined;
	return {
		get llm(): Message[] {
			llm ??= convertToLlm(messages);
			return llm;
		},
		get delta(): string {
			delta ??= serializeConversationDelta(this.llm);
			return delta;
		},
	};
}

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
 * Token ceiling for a summarization LLM call: a fraction of the reserve, clamped
 * to the model's own output limit (unbounded when the model reports none).
 */
export function summarizationMaxTokens(model: Model<any>, reserveTokens: number, fraction: number): number {
	return Math.min(
		Math.floor(fraction * reserveTokens),
		model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
	);
}

/**
 * Expected OUTPUT tokens of the summary about to be generated — the term that
 * makes the cache-aware arithmetic honest (both routes pay for the same summary,
 * each at its OWN model's output rate, and the session model's is typically 3-5x
 * the sibling's; see cache-aware.ts).
 *
 * Two tiers, in order of evidence:
 *  1. A PREVIOUS summary exists → its own size, clamped to the ceiling. Summaries
 *     merge forward, so the last one is the best available predictor of the next —
 *     the same reasoning `estimateCompactionFrameTokens` uses for the frame.
 *  2. Nothing to go on (first compaction) → `maxTokens`, the ceiling the call
 *     actually enforces (0.8×reserve clamped by the model's output limit). That is
 *     an UPPER bound BY DESIGN: over-estimating inflates the session model's leg
 *     more than the sibling's, so the uncertainty resolves toward the sibling — the
 *     always-correct route. Under-estimating would restore exactly the
 *     pro-cache-read bias this term exists to remove.
 *
 * A non-positive/non-finite ceiling (no reserve to derive one from) yields 0, which
 * drops the output term rather than poisoning the comparison with Infinity.
 */
export function expectedSummaryOutputTokens(maxTokens: number, previousSummary?: string): number {
	const ceiling = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0;
	if (previousSummary && previousSummary.length > 0) {
		const prior = estimateStringTokens(previousSummary);
		return ceiling > 0 ? Math.min(ceiling, prior) : prior;
	}
	return ceiling;
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
	serialized?: SerializedWindow,
	cacheAware?: CacheAwareGeneration,
): Promise<string> {
	const maxTokens = summarizationMaxTokens(model, reserveTokens, 0.8);

	// Use update prompt if we have a previous summary, otherwise initial prompt
	const useJson = summarizationUsesJsonOutput();
	let basePrompt = previousSummary
		? useJson
			? UPDATE_SUMMARIZATION_JSON_PROMPT
			: UPDATE_SUMMARIZATION_PROMPT
		: useJson
			? SUMMARIZATION_JSON_PROMPT
			: SUMMARIZATION_PROMPT;
	if (customInstructions) {
		basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
	}

	// Serialize conversation so the model doesn't try to continue it.
	// Convert to LLM messages first (handles custom types like bashExecution, custom, etc.)
	// A precomputed SerializedWindow (from compact()) shares this work with the
	// verification pass; the full-prose serialization is not memoized (no reuser).
	//
	// Built BEFORE the cache-aware routing below because that decision has to price
	// the text route on the payload it really sends (caps + dedup), not on the raw
	// window. Cost of building it when the cache-read route then wins: one local
	// serialization pass, no LLM call, no wire bytes.
	const useDeltaSerialization =
		previousSummary !== undefined &&
		previousSummary.length > 0 &&
		!isTruthyEnvFlag(process.env.PIT_NO_DELTA_SUMMARIZATION);
	const conversationText = useDeltaSerialization
		? (serialized?.delta ?? serializeConversationDelta(convertToLlm(currentMessages)))
		: serializeConversation(serialized?.llm ?? convertToLlm(currentMessages));
	const conversationTag = useDeltaSerialization ? "conversation-delta" : "conversation";

	// Build the prompt with conversation wrapped in tags
	let promptText = `<${conversationTag}>\n${conversationText}\n</${conversationTag}>\n\n`;
	if (previousSummary) {
		promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	}
	promptText += basePrompt;

	// Cache-aware route selection (PER REQUEST — see cache-aware.ts). When the
	// session prefix is hot and the arithmetic favors it, generate the summary by
	// re-reading that cached prefix on the SESSION model (~0.1x cacheRead) instead
	// of serializing the window as fresh 1x text to the sibling `model`. `model`
	// here IS the text/sibling route's model, so `model.cost` is the sibling cost;
	// `cacheAware.sessionModel.cost` is the session cost. The sibling side is priced
	// on `promptText` — the exact request that route issues — and BOTH sides carry
	// the summary's output tokens, billed at their own model's output rate.
	// Kill-switch guards again here so the flag is a hard override no matter how
	// `cacheAware` arrived.
	if (cacheAware && !isTruthyEnvFlag(process.env.PIT_NO_CACHE_AWARE_COMPACTION)) {
		const siblingInputTokens = estimateStringTokens(promptText);
		const expectedSummaryTokens = expectedSummaryOutputTokens(maxTokens, previousSummary);
		const decision = decideCacheAwareRoute({
			siblingInputTokens,
			// Scope guard only: raw message tokens, the same scale as liveMessageTokens.
			foldMessageTokens: sumMessageTokens(currentMessages),
			cacheReadTokens: cacheAware.prefixWireTokens,
			expectedSummaryTokens,
			liveMessageTokens: cacheAware.liveMessageTokens,
			siblingCost: model.cost,
			sessionCost: cacheAware.sessionModel.cost,
			warm: cacheAware.warm,
		});
		recordDiagnostic({
			category: "compaction.cache-aware",
			level: "info",
			source: "compaction.generateSummary",
			context: {
				note: `route=${decision.route} reason=${decision.reason} sibUsd=${decision.siblingCostUsd.toFixed(6)} cacheUsd=${decision.cacheReadCostUsd.toFixed(6)} sibTok=${siblingInputTokens} cacheTok=${cacheAware.prefixWireTokens} outTok=${expectedSummaryTokens} sibOut=${model.cost?.output ?? "?"} sessOut=${cacheAware.sessionModel.cost?.output ?? "?"} retention=${cacheAware.retention}`,
			},
		});
		if (decision.route === "cache-read") {
			const cacheReadSummary = await runCacheAwareSummarization(
				cacheAware,
				basePrompt,
				previousSummary,
				maxTokens,
				thinkingLevel,
				signal,
				streamFn,
			);
			if (cacheReadSummary !== undefined) return cacheReadSummary;
			// Route-specific failure (e.g. a proxy rejecting tool_choice) must never
			// fail the whole compaction — the text/sibling route below is always
			// valid. Aborts do NOT land here (they return partial text above).
			recordDiagnostic({
				category: "compaction.cache-aware",
				level: "warn",
				source: "compaction.generateSummary",
				context: { note: "cache-read route failed — falling back to the text/sibling route" },
			});
		}
	}

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
 * Discriminated outcome of a summarization pass: 'aborted' and 'error' are kept
 * distinct for callers (e.g. branch summarization) that report them differently.
 * The 'aborted' variant still carries any partial `text` the model emitted before
 * cancellation, so compaction's throw-on-error wrapper can return it unchanged
 * (the previous code path extracted text regardless of an aborted stopReason).
 */
export type SummarizationOutcome =
	| { status: "ok"; text: string }
	| { status: "aborted"; text: string }
	| { status: "error"; errorMessage: string | undefined };

/**
 * Run an LLM summarization pass: wrap the prompt in a single user message,
 * complete it (stream-aware when a streamFn is given, reasoning-aware when the
 * model supports it and a thinkingLevel is set), and return a discriminated
 * outcome. Shared by compaction (`runSummarization`, which throws on error and
 * ignores the aborted/ok distinction) and branch summarization (which maps each
 * status to a distinct result field).
 */
export async function runSummarizationWithStatus(
	model: Model<any>,
	promptText: string,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn: StreamFn | undefined,
): Promise<SummarizationOutcome> {
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

	if (response.stopReason === "aborted") {
		return { status: "aborted", text: extractTextFromResponse(response) };
	}
	if (response.stopReason === "error") {
		// Raw message (may be empty); each caller applies its own fallback label.
		return { status: "error", errorMessage: response.errorMessage };
	}
	return { status: "ok", text: extractTextFromResponse(response) };
}

/**
 * Run an LLM summarization pass and return the text, throwing on error with the
 * given label. Thin wrapper over {@link runSummarizationWithStatus} preserving
 * the original behavior: aborted responses fall through to text extraction
 * (stopReason 'aborted' yields no text blocks → empty string), only 'error'
 * throws.
 */
export async function runSummarization(
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
	const outcome = await runSummarizationWithStatus(
		model,
		promptText,
		maxTokens,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		streamFn,
	);
	if (outcome.status === "error") {
		throw new Error(`${errorLabel}: ${outcome.errorMessage || "Unknown error"}`);
	}
	// Both 'ok' and 'aborted' carry text; the original extracted text regardless of an aborted stopReason.
	const raw = outcome.text;
	return summarizationUsesJsonOutput() ? normalizeStructuredSummaryOutput(raw) : raw;
}

/**
 * Cache-read generation route (see cache-aware.ts). Instead of serializing the
 * window as one fresh user message under {@link SUMMARIZATION_SYSTEM_PROMPT},
 * reuse the SESSION prefix verbatim (session system prompt + live message window
 * + tool block) so Anthropic serves it from cache at ~0.1x, and hang the
 * summarization instruction off a tiny trailing user message. Only the PREFIX
 * needs byte-for-byte identity to hit the cache; the trailing user turn is fresh
 * (uncached) but negligible. `toolChoice: "none"` keeps the tool block on the
 * wire (prefix identity) while forbidding tool calls.
 *
 * `basePrompt`, `maxTokens`, and `thinkingLevel` are exactly the ones the text
 * route would use — the ONLY things that change are the model (session, not
 * sibling), the auth (session), the prefix reuse, and tool_choice. An aborted
 * stream falls through to text extraction (partial or empty) like
 * {@link runSummarization}; a hard error returns `undefined` so the caller falls
 * back to the always-valid text/sibling route instead of failing the compaction
 * on a route-specific rejection. The initial `SUMMARIZATION_PROMPT` already
 * opens "The messages above are a conversation to summarize", which reads
 * correctly with the live window above the instruction.
 */
async function runCacheAwareSummarization(
	cacheAware: CacheAwareGeneration,
	basePrompt: string,
	previousSummary: string | undefined,
	maxTokens: number,
	thinkingLevel: ThinkingLevel | undefined,
	signal: AbortSignal | undefined,
	streamFn: StreamFn | undefined,
): Promise<string | undefined> {
	const context = await cacheAware.buildContext();
	const finalPromptText = previousSummary
		? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n${basePrompt}`
		: basePrompt;
	const messages: Message[] = [
		...context.messages,
		{ role: "user", content: [{ type: "text", text: finalPromptText }], timestamp: Date.now() },
	];
	const options: SimpleStreamOptions = {
		maxTokens,
		signal,
		apiKey: cacheAware.sessionApiKey,
		headers: cacheAware.sessionHeaders,
		toolChoice: "none",
		// Ask for the session's prefix on the session's shard — this route only
		// pays off if the cache read actually hits.
		promptCacheKey: cacheAware.sessionPromptCacheKey,
		sessionId: cacheAware.sessionId,
	};
	if (cacheAware.sessionModel.reasoning && thinkingLevel && thinkingLevel !== "off") {
		options.reasoning = thinkingLevel;
	}
	const response = await completeSummarization(
		cacheAware.sessionModel,
		{ systemPrompt: context.systemPrompt, messages, tools: context.tools },
		options,
		streamFn,
	);
	if (response.stopReason === "error") {
		// Route-specific failure → undefined so the caller falls back to the text
		// route. Never throw here: this route is an optimization, not the only path.
		recordDiagnostic({
			category: "compaction.cache-aware",
			level: "warn",
			source: "compaction.runCacheAwareSummarization",
			context: { note: `cache-read summarization failed: ${(response.errorMessage ?? "unknown").slice(0, 150)}` },
		});
		return undefined;
	}
	const raw = extractTextFromResponse(response);
	return summarizationUsesJsonOutput() ? normalizeStructuredSummaryOutput(raw) : raw;
}

// ============================================================================
// Self-correction verification
// ============================================================================

const VERIFICATION_PROMPT = `Critically evaluate the context summary below against the source conversation provided in <conversation-delta> above this prompt. Did you omit any of the following from that source?
- Exact file paths or line numbers
- Error messages or exception types
- Function/variable names
- User constraints or preferences
- Key decisions and their rationale

The <conversation-delta> block is a compact JSON array of events:
[{"k":"u","t":"user text"},{"k":"a","t":"assistant text"},{"k":"c","n":"toolName","a":{args}},{"k":"r","n":"toolName","t":"result excerpt","e":1}]
Keys: u=user, a=assistant, c=tool call, r=tool result (e=1 only on error). Thinking is omitted.

Compare the summary against that source. If anything material is missing or imprecise, produce a FINAL improved summary using the same format.

STRICT ANTI-FABRICATION RULE: only add facts that appear VERBATIM (or as a clear paraphrase) in the <conversation-delta> source. NEVER add file paths, function names, error messages, or claims that are not present in the source — that is fabrication, not correction. If nothing is missing, repeat the summary exactly as-is.

<summary>
{SUMMARY}
</summary>`;

/**
 * Head/tail char budgets for the verification source excerpt. Large windows
 * would otherwise blow the verifier request; the head keeps the earliest
 * turns (goal, constraints, first decisions) and the tail keeps the most
 * recent (current work, latest errors) — the two regions most likely to be
 * silently dropped from a summary.
 */
const VERIFY_SOURCE_HEAD_BUDGET = 24_000;
const VERIFY_SOURCE_TAIL_BUDGET = 8_000;

/**
 * Build a bounded, compact serialization of the compacted window for the
 * self-correction verification pass. The verifier MUST see the source it is
 * checking the summary against — without it the pass can only fabricate
 * plausible additions, never detect real omissions (the prior prompt carried
 * the summary alone).
 *
 * Uses {@link serializeConversationDelta} (compact JSON, thinking omitted) over
 * the convertToLlm form of the (already pruned) messages, then bounds the
 * result with a head+tail excerpt so a huge window cannot blow the verifier
 * request. Turn-prefix messages (split-turn) are prepended to the main window
 * so the verifier sees the full compacted span in source order.
 */
export function buildVerificationSource(
	messagesToSummarize: AgentMessage[],
	turnPrefixMessages: AgentMessage[],
	mainWindow?: SerializedWindow,
	prefixWindow?: SerializedWindow,
): string {
	const main = (mainWindow ?? createSerializedWindow(messagesToSummarize)).delta;
	const prefix =
		turnPrefixMessages.length > 0 ? (prefixWindow ?? createSerializedWindow(turnPrefixMessages)).delta : "";
	const combined = prefix ? `${prefix}\n${main}` : main;
	if (combined.length <= VERIFY_SOURCE_HEAD_BUDGET + VERIFY_SOURCE_TAIL_BUDGET) {
		return combined;
	}
	return headTailExcerptShared(combined, {
		headBudget: VERIFY_SOURCE_HEAD_BUDGET,
		tailBudget: VERIFY_SOURCE_TAIL_BUDGET,
		snapWindow: 400,
		marker: (elidedChars) => `[… ${elidedChars} characters elided …]`,
	});
}

/**
 * Below this many summarized-input tokens, skip the SEPARATE self-correction
 * LLM call. M15 raised this from 25k to 80k: the summarizer prompt now carries
 * an inline self-check (the model reviews its own summary against the window
 * and emits corrections in the same response — see the "Corrections
 * (self-check)" section / `corrections` JSON field, merged deterministically),
 * so every compaction gets a verification pass for free. Only very large
 * windows — where the verify source excerpt still adds real signal over the
 * single-call self-check — pay the second LLM call.
 */
export const VERIFY_MIN_INPUT_TOKENS = 80_000;

/**
 * Sum content-aware token estimates across a message list — a PURE estimate
 * that never consults assistant `usage`. After a compaction the kept assistant
 * messages still carry their pre-compaction usage, so the usage-based
 * estimateContextTokens reads as if nothing was compacted; callers re-checking
 * post-compaction pressure must use this instead.
 */
export function sumMessageTokens(messages: AgentMessage[]): number {
	let total = 0;
	for (const message of messages) total += estimateTokens(message);
	return total;
}

/** Token-count runaway bound: reject corrections above this ratio regardless of grounding. */
const VERIFY_INFLATION_HARD_LIMIT = 1.5;
/** Inflation ratio above which a correction must be grounded in the source to be accepted. */
const VERIFY_INFLATION_SOFT_LIMIT = 1.1;

/** Path-like tokens (src/foo/bar.ts, module.py) — the facts a verifier legitimately adds. */
const GROUNDABLE_PATH_RE = /[A-Za-z0-9_@][\w./-]*\.[A-Za-z]\w{0,7}/g;
/** Backticked spans — identifiers/errors the verifier cites. */
const GROUNDABLE_BACKTICK_RE = /`([^`\n]{4,120})`/g;

/**
 * True when at least one line the verifier ADDED to the summary cites a token
 * (file path or backticked identifier/error) that appears VERBATIM in the
 * verification source. This is the deterministic stand-in for "the correction
 * fixes a material omission": a grounded added fact came from the window, not
 * from fabrication, so oversize output is the correction working as intended.
 */
export function correctionCitesSource(original: string, corrected: string, source: string): boolean {
	const originalLines = new Set(
		original
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	);
	for (const rawLine of corrected.split("\n")) {
		const line = rawLine.trim();
		if (!line || originalLines.has(line)) continue;
		for (const match of line.matchAll(GROUNDABLE_PATH_RE)) {
			if (match[0].length >= 4 && source.includes(match[0])) return true;
		}
		for (const match of line.matchAll(GROUNDABLE_BACKTICK_RE)) {
			if (source.includes(match[1])) return true;
		}
	}
	return false;
}

/**
 * Run a self-correction pass on a generated summary. A second LLM call
 * evaluates the summary for omissions against the source conversation and
 * produces a corrected version. The {@link source} argument MUST be a
 * serialization of the compacted window (see {@link buildVerificationSource});
 * without it the pass can only fabricate additions, never detect omissions.
 *
 * Inflation gate (M15): the old blind ">10% → discard" threw away exactly the
 * case where the verifier found material omissions — the paid second call was
 * wasted. Oversize corrections are now ACCEPTED when they are grounded (an
 * added line cites a path/identifier present verbatim in the source, see
 * {@link correctionCitesSource}); ungrounded inflation still falls back to the
 * original, as does any rewrite beyond {@link VERIFY_INFLATION_HARD_LIMIT}.
 */
export async function verifySummary(
	summary: string,
	source: string,
	model: Model<any>,
	maxTokens: number,
	apiKey: string | undefined,
	headers: Record<string, string> | undefined,
	signal: AbortSignal | undefined,
	thinkingLevel: ThinkingLevel | undefined,
	streamFn?: StreamFn,
): Promise<string> {
	const promptText = `<conversation-delta>\n${source}\n</conversation-delta>\n\n${VERIFICATION_PROMPT.replace(
		"{SUMMARY}",
		summary,
	)}`;
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

		const originalTokens = Math.ceil(summary.length / CHARS_PER_TOKEN_PROSE);
		const correctedTokens = Math.ceil(corrected.length / CHARS_PER_TOKEN_PROSE);
		if (correctedTokens > originalTokens * VERIFY_INFLATION_SOFT_LIMIT) {
			// Grounded material corrections may legitimately exceed the soft limit;
			// runaway rewrites and ungrounded inflation never survive.
			if (
				correctedTokens > originalTokens * VERIFY_INFLATION_HARD_LIMIT ||
				!correctionCitesSource(summary, corrected, source)
			) {
				return summary;
			}
		}

		return corrected;
	} catch {
		return summary;
	}
}
