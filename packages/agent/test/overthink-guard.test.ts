import { describe, expect, it } from "vitest";
import {
	buildOverthinkReminderMessage,
	estimateThinkingTokensFromChars,
	formatOverthinkSteerDisplayLine,
	isOverthinkSteerMessage,
	OverthinkTracker,
	THINKING_CHARS_PER_TOKEN,
} from "../src/overthink-guard.js";

describe("OverthinkTracker", () => {
	it("interrupts when one thinking block exceeds the token threshold without tools", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		const threshold = 10;
		const longDelta = "x".repeat(THINKING_CHARS_PER_TOKEN * threshold);
		tracker.onThinkingDelta(0, longDelta);
		expect(tracker.shouldInterrupt(0, threshold)).toBe(true);
		expect(tracker.getEstimatedTokens(0)).toBe(threshold);
	});

	it("does not interrupt after a tool call has started", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "x".repeat(THINKING_CHARS_PER_TOKEN * 2000));
		tracker.onToolCallStart();
		expect(tracker.shouldInterrupt(0, 10)).toBe(false);
	});

	it("resets per thinking block on thinking_start", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "x".repeat(100));
		tracker.onThinkingStart(0);
		expect(tracker.getEstimatedTokens(0)).toBe(0);
	});

	it("counts text_delta when watchTextDelta is enabled and no thinking arrived", () => {
		const tracker = new OverthinkTracker(true);
		tracker.onTextStart(0);
		tracker.onTextDelta(0, "x".repeat(THINKING_CHARS_PER_TOKEN * 12));
		expect(tracker.shouldInterrupt(0, 10)).toBe(true);
	});

	it("stops accumulating further text_delta after the first thinking_delta", () => {
		const tracker = new OverthinkTracker(true);
		tracker.onTextStart(0);
		tracker.onTextDelta(0, "x".repeat(THINKING_CHARS_PER_TOKEN * 5));
		tracker.onThinkingDelta(1, "ok");
		tracker.onTextStart(0);
		tracker.onTextDelta(0, "x".repeat(THINKING_CHARS_PER_TOKEN * 200));
		expect(tracker.getEstimatedTokens(0)).toBe(5);
		expect(tracker.shouldInterrupt(0, 10)).toBe(false);
		expect(tracker.hasSeenThinkingDelta()).toBe(true);
	});
});

describe("buildOverthinkReminderMessage", () => {
	it("marks the reminder with a non-enumerable runtime flag", () => {
		const message = buildOverthinkReminderMessage({ estimatedTokens: 1200, threshold: 1000 });
		expect(message.role).toBe("user");
		expect((message as { _overthink_injected?: boolean })._overthink_injected).toBe(true);
		expect(JSON.stringify(message)).not.toContain("_overthink_injected");
		expect(JSON.stringify(message)).not.toContain("_overthink_tokens");
		expect(message.role).toBe("user");
		if (message.role !== "user") {
			return;
		}
		const block = message.content[0];
		if (typeof block === "string" || block.type !== "text") {
			throw new Error("expected text block");
		}
		expect(block.text).toContain("[overthink]");
		expect(block.text).toContain("1200");
	});
});

describe("estimateThinkingTokensFromChars", () => {
	it("uses ceil(chars/4)", () => {
		expect(estimateThinkingTokensFromChars(0)).toBe(0);
		expect(estimateThinkingTokensFromChars(4)).toBe(1);
		expect(estimateThinkingTokensFromChars(5)).toBe(2);
	});
});

describe("isOverthinkSteerMessage", () => {
	it("detects live messages via _overthink_injected", () => {
		const message = buildOverthinkReminderMessage({ estimatedTokens: 1200, threshold: 1000 });
		expect(isOverthinkSteerMessage(message)).toBe(true);
	});

	it("detects JSONL-restored messages via text marker", () => {
		const message = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: "<system-reminder>[overthink] Internal reasoning for this turn exceeded ~1203 tokens (limit ~1000) without calling a tool.</system-reminder>",
				},
			],
			timestamp: Date.now(),
		};
		expect(isOverthinkSteerMessage(message)).toBe(true);
	});

	it("returns false for normal user messages", () => {
		expect(
			isOverthinkSteerMessage({
				role: "user",
				content: [{ type: "text", text: "fix the bug in footer.ts" }],
				timestamp: Date.now(),
			}),
		).toBe(false);
	});
});

describe("formatOverthinkSteerDisplayLine", () => {
	it("formats from reminder text", () => {
		const message = buildOverthinkReminderMessage({ estimatedTokens: 1203, threshold: 1000 });
		expect(formatOverthinkSteerDisplayLine(message)).toBe(
			"Reasoning exceeded ~1203 tokens (limit ~1000). Model notified.",
		);
	});

	it("formats restored JSONL text without runtime markers", () => {
		const message = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: "<system-reminder>[overthink] Internal reasoning for this turn exceeded ~1003 tokens (limit ~1000) without calling a tool.</system-reminder>",
				},
			],
			timestamp: Date.now(),
		};
		expect(formatOverthinkSteerDisplayLine(message)).toBe(
			"Reasoning exceeded ~1003 tokens (limit ~1000). Model notified.",
		);
	});
});
