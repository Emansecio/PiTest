/**
 * Live-stream guard against unbounded internal reasoning in a single turn.
 *
 * Complements the context-economy thinking cap (K4), which trims *stale*
 * thinking blocks before send. This module interrupts the *current* stream when
 * one reasoning block grows too large without any tool call — the pattern weak
 * open models (GLM, Qwen, etc.) exhibit in multi-turn agent loops.
 */

import type { AgentMessage } from "./types.ts";

/** Char/token ratio aligned with `estimateTokens` in compaction (`ceil(len/4)`). */
export const THINKING_CHARS_PER_TOKEN = 4;

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
}

/** Tracks per-block reasoning volume and whether tool calls have started. */
export class OverthinkTracker {
	private blockChars = new Map<number, number>();
	private toolCallStarted = false;
	private seenThinkingDelta = false;
	private readonly watchTextDelta: boolean;

	constructor(watchTextDelta = false) {
		this.watchTextDelta = watchTextDelta;
	}

	onBlockStart(contentIndex: number): void {
		this.blockChars.set(contentIndex, 0);
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

	shouldInterrupt(contentIndex: number, threshold: number): boolean {
		if (this.toolCallStarted) {
			return false;
		}
		return estimateThinkingTokensFromChars(this.blockChars.get(contentIndex) ?? 0) >= threshold;
	}

	getEstimatedTokens(contentIndex: number): number {
		return estimateThinkingTokensFromChars(this.blockChars.get(contentIndex) ?? 0);
	}

	hasSeenThinkingDelta(): boolean {
		return this.seenThinkingDelta;
	}

	reset(): void {
		this.blockChars.clear();
		this.toolCallStarted = false;
		this.seenThinkingDelta = false;
	}

	private accumulate(contentIndex: number, delta: string): number {
		const prev = this.blockChars.get(contentIndex) ?? 0;
		const next = prev + delta.length;
		this.blockChars.set(contentIndex, next);
		return estimateThinkingTokensFromChars(next);
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

export function buildOverthinkReminderMessage(info: OverthinkInterruptInfo): AgentMessage {
	const text =
		`<system-reminder>[overthink] Internal reasoning for this turn exceeded ~${info.estimatedTokens} tokens ` +
		`(limit ~${info.threshold}) without calling a tool. ` +
		`Stop extended deliberation ("wait… actually… on second thought…") and act now: ` +
		`call the tool you need, or state one concrete next step in a short paragraph. ` +
		`Do not resume a long chain-of-thought; interleave brief reasoning with tool use.</system-reminder>`;
	const message = {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: Date.now(),
	};
	Object.defineProperty(message, "_overthink_injected", {
		value: true,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	Object.defineProperty(message, "_overthink_tokens", {
		value: info.estimatedTokens,
		enumerable: true,
		writable: false,
		configurable: false,
	});
	return message as unknown as AgentMessage;
}
