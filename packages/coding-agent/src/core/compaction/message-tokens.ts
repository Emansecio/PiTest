/**
 * Message token estimation.
 *
 * Per-message char counting, image token costs, and token estimates used by
 * cut-point selection, pruning, and the wire estimate.
 * Extracted from compaction.ts (deep-modules decomposition); public surface
 * is re-exported from compaction.ts so existing importers are unaffected.
 */

import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage } from "@pit/ai";
import { CHARS_PER_TOKEN_DENSE, CHARS_PER_TOKEN_PROSE, estimateStringTokens, isDenseText } from "@pit/ai";

// Chars-per-token ratios and the density heuristic live in @pit/ai
// token-estimate.ts (M7 single source of truth) — imported above.
/** Floor for an image block's token cost — the legacy flat estimate; typical screenshots stay here. */
const IMAGE_TOKENS_MIN = 1200;
/** Ceiling for an image block's token cost — providers downscale huge images, so cost saturates. */
const IMAGE_TOKENS_MAX = 8_000;
/** 4 base64 chars encode 3 raw bytes. */
const BASE64_BYTES_PER_CHAR = 3 / 4;
/**
 * ~750 raw bytes per image token. HONEST PROXY: providers bill roughly
 * (width×height)/750 pixels-per-token, but without decoding the image all we
 * have is the encoded byte size, which grows with the same order as pixel count
 * for typical screenshots. Large images therefore estimate higher than the old
 * flat 1200 instead of being silently undercounted.
 */
const IMAGE_BYTES_PER_TOKEN = 750;

/**
 * Estimate an image block's token cost from its base64 payload size, clamped to
 * [IMAGE_TOKENS_MIN, IMAGE_TOKENS_MAX]. Missing/odd payloads fall back to the
 * legacy flat floor.
 */
export function imageBlockTokens(base64Data: unknown): number {
	if (typeof base64Data !== "string" || base64Data.length === 0) return IMAGE_TOKENS_MIN;
	const bytes = Math.ceil(base64Data.length * BASE64_BYTES_PER_CHAR);
	return Math.min(IMAGE_TOKENS_MAX, Math.max(IMAGE_TOKENS_MIN, Math.ceil(bytes / IMAGE_BYTES_PER_TOKEN)));
}

/** Classified char counts for a message — imutável, logo cacheável. */
interface MessageCharCounts {
	dense: number;
	prose: number;
	images: number; // already in tokens (imageBlockTokens per image)
}

const charCountCache = new WeakMap<AgentMessage, MessageCharCounts>();
const argsLengthCache = new WeakMap<object, number>();

export function cachedArgsLength(args: unknown): number {
	if (typeof args === "object" && args !== null) {
		const cached = argsLengthCache.get(args);
		if (cached !== undefined) return cached;
		const len = JSON.stringify(args).length;
		argsLengthCache.set(args, len);
		return len;
	}
	return JSON.stringify(args).length;
}

/** Min length for a tool-call arg STRING value to be worth eliding (keeps paths/flags intact). */
const TOOLCALL_ARG_VALUE_MARK_THRESHOLD = 200;

/**
 * P0: the exact prefix of the elision marker produced by {@link pruneToolCallArguments}.
 * A mutating tool MUST NEVER execute arguments that contain this text — it means the
 * historical copy was pruned and the "content" is a placeholder, not a payload.
 * Detected by `containsElisionMarker`; rejected by the dispatcher (agent-loop.ts).
 */
const ELISION_MARKER_PREFIX = "chars elided";

/**
 * P0 — true when any string value inside `args` carries the internal elision
 * marker produced by {@link pruneToolCallArguments} (`[N chars elided — …]`).
 *
 * This is the dispatcher's fail-safe: a mutating tool call whose arguments were
 * pruned for HISTORY must never be executed as if the marker were the real
 * payload. Detection is deliberately marker-prefix based (`chars elided`), so a
 * legitimate user string containing that phrase would be a false positive — an
 * acceptable cost for a fail-safe guard on mutation tools, which carry file
 * bodies/edits, not prose.
 */
export function containsElisionMarker(args: unknown): boolean {
	if (typeof args === "string") return args.includes(ELISION_MARKER_PREFIX);
	if (Array.isArray(args)) {
		for (const item of args) {
			if (containsElisionMarker(item)) return true;
		}
		return false;
	}
	if (typeof args === "object" && args !== null) {
		for (const value of Object.values(args as Record<string, unknown>)) {
			if (containsElisionMarker(value)) return true;
		}
	}
	return false;
}

/**
 * Returns a deep copy of a mutation tool-call's arguments with long string
 * values (file bodies, edit oldText/newText) replaced by a short marker, plus
 * the number of chars elided. Short values (paths, flags) pass through. Returns
 * undefined when nothing was large enough to prune. The original object is never
 * mutated — callers reassign the returned copy onto a cloned tool-call block.
 *
 * `failed` selects the marker: the default asserts the content landed on disk,
 * which is a LIE for a rejected write/edit — the summarizer and the
 * post-compaction model would inherit it. Callers that know the corresponding
 * tool result errored must pass `failed=true` for the honest marker.
 */
export function pruneToolCallArguments(args: unknown, failed = false): { pruned: unknown; saved: number } | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	let saved = 0;
	const walk = (value: unknown): unknown => {
		if (typeof value === "string") {
			if (value.length <= TOOLCALL_ARG_VALUE_MARK_THRESHOLD) return value;
			saved += value.length;
			return failed
				? `[${value.length} chars elided — the write FAILED; content was NOT applied to disk]`
				: `[${value.length} chars elided — applied to disk; the file is the source of truth]`;
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
 * Estimate tokens for a raw text string, classifying it as dense or prose.
 * Exported for use in pruneOldToolOutputs and tests. Thin re-export of the
 * shared heuristic in @pit/ai token-estimate.ts (M7 single source of truth).
 */
export function estimateTextTokens(text: string, forceDense = false): number {
	return estimateStringTokens(text, forceDense);
}

/** Count chars in a message, separated by density. Images stored as token count. */
export function countMessageChars(message: AgentMessage): MessageCharCounts {
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
					} else if (block.type === "image") {
						// Same accounting the toolResult branch below already does. Pasted
						// screenshots and `--image` attachments arrive as image blocks on a
						// USER message, and counting them as zero hid whole megabytes of
						// base64 from the overflow guard.
						counts.images += imageBlockTokens((block as { data?: unknown }).data);
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
						counts.images += imageBlockTokens((block as { data?: unknown }).data);
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
 * prose uses ~4 chars/token. Images cost imageBlockTokens each (size-scaled).
 * Results are cached per message object (messages are immutable once created).
 */
export function estimateTokens(message: AgentMessage): number {
	const counts = countMessageChars(message);
	return (
		Math.ceil(counts.prose / CHARS_PER_TOKEN_PROSE) + Math.ceil(counts.dense / CHARS_PER_TOKEN_DENSE) + counts.images
	);
}
