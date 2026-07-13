/**
 * Live-stream guard against unbounded internal reasoning in a single turn.
 *
 * Complements the context-economy thinking cap (K4), which trims *stale*
 * thinking blocks before send. This module interrupts the *current* stream when
 * one reasoning block grows too large without any tool call — the pattern weak
 * open models (GLM, Qwen, etc.) exhibit in multi-turn agent loops.
 */

import { CHARS_PER_TOKEN_PROSE } from "@pit/ai";
import type { AgentMessage } from "./types.ts";

/** Char/token ratio for streamed reasoning — the shared prose divisor from @pit/ai token-estimate.ts. */
export const THINKING_CHARS_PER_TOKEN = CHARS_PER_TOKEN_PROSE;

export interface OverthinkGuardConfig {
	enabled: boolean;
	/** Estimated-token ceiling for one contiguous thinking block in a turn. */
	tokenThreshold: number;
	/** Injections allowed before the turn bails with a terminal error message. */
	maxRetriesPerTurn: number;
	/**
	 * When true, also count `text_delta` before any `thinking_delta` arrives.
	 * Open-weight models routed via OpenAI-compat often stream reasoning as plain
	 * assistant text instead of thinking blocks.
	 */
	watchTextDelta?: boolean;
}

export interface OverthinkInterruptInfo {
	estimatedTokens: number;
	threshold: number;
	/** Which condition fired. Absent on legacy call sites; defaults to volumetric. */
	reason?: "volume" | "rumination";
	/** Self-reversal markers counted in the block, when reason === "rumination". */
	markerCount?: number;
}

/**
 * Case-insensitive self-reversal markers whose repetition within a single
 * reasoning block signals rumination. Word boundaries matter: "await" and
 * "waiting" must NOT count as "wait".
 */
export const OVERTHINK_RUMINATION_MARKERS = [
	"wait",
	"actually",
	"on second thought",
	"let me reconsider",
	"hmm, but",
	"scratch that",
	"hold on",
	"let me rethink",
] as const;

/** Longest marker length; drives the rolling tail-buffer size for split dedup. */
const OVERTHINK_LONGEST_MARKER_LEN = Math.max(...OVERTHINK_RUMINATION_MARKERS.map((m) => m.length));

/**
 * Rolling tail-buffer length carried between streaming deltas so a marker split
 * across a chunk boundary is still matched exactly once. Must be at least
 * (longestMarkerLength - 1); kept a little larger for margin.
 */
const OVERTHINK_MARKER_TAIL_LEN = Math.max(32, OVERTHINK_LONGEST_MARKER_LEN - 1);

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Single global regex over all markers with word boundaries; scanned incrementally. */
const OVERTHINK_RUMINATION_REGEX = new RegExp(
	`\\b(?:${OVERTHINK_RUMINATION_MARKERS.map(escapeRegExp).join("|")})\\b`,
	"gi",
);

/** Interrupt when at least this many self-reversal markers appear in one block. */
export const DEFAULT_OVERTHINK_RUMINATION_MARKER_THRESHOLD = 4;
/** …and only once the block is at least this many estimated tokens (false-positive guard). */
export const DEFAULT_OVERTHINK_RUMINATION_MIN_TOKENS = 400;

/** Tracks per-block reasoning volume and whether tool calls have started. */
export class OverthinkTracker {
	private blockChars = new Map<number, number>();
	private markerCounts = new Map<number, number>();
	private blockTails = new Map<number, string>();
	private toolCallStarted = false;
	private seenThinkingDelta = false;
	private readonly watchTextDelta: boolean;

	constructor(watchTextDelta = false) {
		this.watchTextDelta = watchTextDelta;
	}

	onBlockStart(contentIndex: number): void {
		this.blockChars.set(contentIndex, 0);
		this.markerCounts.set(contentIndex, 0);
		this.blockTails.set(contentIndex, "");
	}

	onThinkingStart(contentIndex: number): void {
		this.onBlockStart(contentIndex);
	}

	onTextStart(contentIndex: number): void {
		if (this.watchTextDelta && !this.seenThinkingDelta) {
			this.onBlockStart(contentIndex);
		}
	}

	onThinkingDelta(contentIndex: number, delta: string): number {
		this.seenThinkingDelta = true;
		return this.accumulate(contentIndex, delta);
	}

	onTextDelta(contentIndex: number, delta: string): number {
		if (!this.watchTextDelta || this.seenThinkingDelta) {
			return this.getEstimatedTokens(contentIndex);
		}
		return this.accumulate(contentIndex, delta);
	}

	onToolCallStart(): void {
		this.toolCallStarted = true;
	}

	/**
	 * Full interrupt info for the block, or null if no condition fires. Rumination
	 * (repeated self-reversals past a small size floor) is checked first because it
	 * fires at a fraction of the volumetric cost; the volumetric ceiling is the
	 * unchanged fallback.
	 */
	getInterruptInfo(contentIndex: number, threshold: number): OverthinkInterruptInfo | null {
		if (this.toolCallStarted) {
			return null;
		}
		const estimatedTokens = this.getEstimatedTokens(contentIndex);
		const markerCount = this.markerCounts.get(contentIndex) ?? 0;
		if (
			markerCount >= DEFAULT_OVERTHINK_RUMINATION_MARKER_THRESHOLD &&
			estimatedTokens >= DEFAULT_OVERTHINK_RUMINATION_MIN_TOKENS
		) {
			return { estimatedTokens, threshold, reason: "rumination", markerCount };
		}
		if (estimatedTokens >= threshold) {
			return { estimatedTokens, threshold, reason: "volume" };
		}
		return null;
	}

	shouldInterrupt(contentIndex: number, threshold: number): boolean {
		return this.getInterruptInfo(contentIndex, threshold) !== null;
	}

	getEstimatedTokens(contentIndex: number): number {
		return estimateThinkingTokensFromChars(this.blockChars.get(contentIndex) ?? 0);
	}

	getMarkerCount(contentIndex: number): number {
		return this.markerCounts.get(contentIndex) ?? 0;
	}

	hasSeenThinkingDelta(): boolean {
		return this.seenThinkingDelta;
	}

	reset(): void {
		this.blockChars.clear();
		this.markerCounts.clear();
		this.blockTails.clear();
		this.toolCallStarted = false;
		this.seenThinkingDelta = false;
	}

	private accumulate(contentIndex: number, delta: string): number {
		const prev = this.blockChars.get(contentIndex) ?? 0;
		const next = prev + delta.length;
		this.blockChars.set(contentIndex, next);
		this.countMarkers(contentIndex, delta);
		return estimateThinkingTokensFromChars(next);
	}

	/**
	 * Incrementally count self-reversal markers in the block. Scans only
	 * (tailBuffer + newDelta) where tailBuffer holds the last few chars of the
	 * previously scanned text, then counts only matches that END inside the new
	 * delta portion — a marker fully inside the old tail was already counted on a
	 * prior call, so this dedups markers split across a chunk boundary.
	 */
	private countMarkers(contentIndex: number, delta: string): void {
		if (delta.length === 0) {
			return;
		}
		const tail = this.blockTails.get(contentIndex) ?? "";
		const scan = tail + delta;
		OVERTHINK_RUMINATION_REGEX.lastIndex = 0;
		let added = 0;
		for (const match of scan.matchAll(OVERTHINK_RUMINATION_REGEX)) {
			const end = match.index + match[0].length;
			// Only count matches that reach into the new delta; matches ending
			// within the carried-over tail were counted on a previous call.
			if (end > tail.length) {
				added++;
			}
		}
		if (added > 0) {
			this.markerCounts.set(contentIndex, (this.markerCounts.get(contentIndex) ?? 0) + added);
		}
		this.blockTails.set(
			contentIndex,
			scan.length > OVERTHINK_MARKER_TAIL_LEN ? scan.slice(-OVERTHINK_MARKER_TAIL_LEN) : scan,
		);
	}
}

export function estimateThinkingTokensFromChars(chars: number): number {
	if (chars <= 0) {
		return 0;
	}
	return Math.ceil(chars / THINKING_CHARS_PER_TOKEN);
}

export const DEFAULT_OVERTHINK_WEAK_TOKEN_THRESHOLD = 1000;
export const DEFAULT_OVERTHINK_STRONG_TOKEN_THRESHOLD = 2500;
export const DEFAULT_OVERTHINK_MAX_RETRIES_PER_TURN = 2;

export const OVERTHINK_STEER_TEXT_MARKER = "<system-reminder>[overthink]";

const OVERTHINK_TOKEN_REGEX = /exceeded ~(\d+) tokens \(limit ~(\d+)\)/;
const OVERTHINK_RUMINATION_TEXT_REGEX = /detected (\d+) self-reversals/i;

function getUserMessageText(message: AgentMessage): string {
	if (message.role !== "user") {
		return "";
	}
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("");
}

/** True for live (_overthink_injected) or JSONL-restored overthink steer messages. */
export function isOverthinkSteerMessage(message: AgentMessage): boolean {
	if (message.role !== "user") {
		return false;
	}
	const tagged = message as { _overthink_injected?: boolean };
	if (tagged._overthink_injected === true) {
		return true;
	}
	return getUserMessageText(message).includes(OVERTHINK_STEER_TEXT_MARKER);
}

/** One-line TUI summary; the full system-reminder text stays in LLM context. */
export function formatOverthinkSteerDisplayLine(message: AgentMessage): string {
	const text = getUserMessageText(message);
	const ruminationMatch = text.match(OVERTHINK_RUMINATION_TEXT_REGEX);
	if (ruminationMatch) {
		return `Reasoning looped on ${ruminationMatch[1]} self-reversals. Model notified.`;
	}
	const taggedMarkers = message as { _overthink_markers?: number };
	if (taggedMarkers._overthink_markers !== undefined) {
		return `Reasoning looped on ${taggedMarkers._overthink_markers} self-reversals. Model notified.`;
	}
	const match = text.match(OVERTHINK_TOKEN_REGEX);
	if (match) {
		return `Reasoning exceeded ~${match[1]} tokens (limit ~${match[2]}). Model notified.`;
	}
	const tagged = message as { _overthink_tokens?: number };
	if (tagged._overthink_tokens !== undefined) {
		return `Reasoning exceeded ~${tagged._overthink_tokens} tokens. Model notified.`;
	}
	return "Reasoning limit exceeded. Model notified.";
}

export function buildOverthinkReminderMessage(info: OverthinkInterruptInfo): AgentMessage {
	const action =
		`Stop extended deliberation ("wait… actually… on second thought…") and act now: ` +
		`call the tool you need, or state one concrete next step in a short paragraph. ` +
		`Do not resume a long chain-of-thought; interleave brief reasoning with tool use.`;
	const text =
		info.reason === "rumination"
			? `<system-reminder>[overthink] Detected ${info.markerCount ?? 0} self-reversals ` +
				`("wait… actually… on second thought…") within one reasoning block (~${info.estimatedTokens} tokens). ` +
				`${action}</system-reminder>`
			: `<system-reminder>[overthink] Internal reasoning for this turn exceeded ~${info.estimatedTokens} tokens ` +
				`(limit ~${info.threshold}) without calling a tool. ${action}</system-reminder>`;
	const message = {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
	Object.defineProperty(message, "_overthink_injected", {
		value: true,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(message, "_overthink_tokens", {
		value: info.estimatedTokens,
		enumerable: false,
		writable: false,
		configurable: false,
	});
	if (info.reason === "rumination") {
		Object.defineProperty(message, "_overthink_markers", {
			value: info.markerCount ?? 0,
			enumerable: false,
			writable: false,
			configurable: false,
		});
	}
	return message as unknown as AgentMessage;
}
