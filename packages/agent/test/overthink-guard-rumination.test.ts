import { describe, expect, it } from "vitest";
import {
	buildOverthinkReminderMessage,
	DEFAULT_OVERTHINK_RUMINATION_MARKER_THRESHOLD,
	DEFAULT_OVERTHINK_RUMINATION_MIN_TOKENS,
	formatOverthinkSteerDisplayLine,
	isOverthinkSteerMessage,
	OverthinkTracker,
	THINKING_CHARS_PER_TOKEN,
} from "../src/overthink-guard.js";

// Volumetric threshold high enough that only rumination can fire in these tests.
const HIGH_VOLUME_THRESHOLD = 100_000;

/** Chars needed to clear the rumination min-token floor with margin. */
const OVER_FLOOR_CHARS = THINKING_CHARS_PER_TOKEN * (DEFAULT_OVERTHINK_RUMINATION_MIN_TOKENS + 10);

describe("OverthinkTracker rumination detection", () => {
	it("counts a marker split across two deltas exactly once", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "reasoning act");
		tracker.onThinkingDelta(0, "ually more text");
		expect(tracker.getMarkerCount(0)).toBe(1);
	});

	it("does not recount a marker on subsequent deltas", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "hold on, ");
		tracker.onThinkingDelta(0, "let me think about the plan ");
		tracker.onThinkingDelta(0, "and then continue onward");
		expect(tracker.getMarkerCount(0)).toBe(1);
	});

	it("respects word boundaries: 'await'/'waiting' not counted, standalone 'wait' counted", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "await waiting wait");
		expect(tracker.getMarkerCount(0)).toBe(1);
	});

	it("counts every occurrence and multi-word markers", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "wait. actually, on second thought, let me reconsider. scratch that.");
		// wait, actually, on second thought, let me reconsider, scratch that = 5
		expect(tracker.getMarkerCount(0)).toBe(5);
	});

	it("interrupts at 4 markers AND >= min tokens (no tool call)", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, `wait actually hold on scratch that ${"z".repeat(OVER_FLOOR_CHARS)}`);
		expect(tracker.getMarkerCount(0)).toBeGreaterThanOrEqual(DEFAULT_OVERTHINK_RUMINATION_MARKER_THRESHOLD);
		const info = tracker.getInterruptInfo(0, HIGH_VOLUME_THRESHOLD);
		expect(info).not.toBeNull();
		expect(info?.reason).toBe("rumination");
		expect(info?.markerCount).toBe(4);
		expect(tracker.shouldInterrupt(0, HIGH_VOLUME_THRESHOLD)).toBe(true);
	});

	it("does NOT interrupt at 4 markers below the min-token floor", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "wait actually hold on scratch that");
		expect(tracker.getMarkerCount(0)).toBe(4);
		expect(tracker.getEstimatedTokens(0)).toBeLessThan(DEFAULT_OVERTHINK_RUMINATION_MIN_TOKENS);
		expect(tracker.getInterruptInfo(0, HIGH_VOLUME_THRESHOLD)).toBeNull();
	});

	it("does NOT interrupt at 3 markers above the min-token floor", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, `wait actually hold on ${"z".repeat(OVER_FLOOR_CHARS)}`);
		expect(tracker.getMarkerCount(0)).toBe(3);
		expect(tracker.getEstimatedTokens(0)).toBeGreaterThanOrEqual(DEFAULT_OVERTHINK_RUMINATION_MIN_TOKENS);
		expect(tracker.getInterruptInfo(0, HIGH_VOLUME_THRESHOLD)).toBeNull();
	});

	it("suppresses the rumination interrupt once a tool call starts", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, `wait actually hold on scratch that ${"z".repeat(OVER_FLOOR_CHARS)}`);
		tracker.onToolCallStart();
		expect(tracker.getInterruptInfo(0, HIGH_VOLUME_THRESHOLD)).toBeNull();
		expect(tracker.shouldInterrupt(0, HIGH_VOLUME_THRESHOLD)).toBe(false);
	});

	it("counts markers on the watched text_delta path too", () => {
		const tracker = new OverthinkTracker(true);
		tracker.onTextStart(0);
		tracker.onTextDelta(0, `wait actually hold on scratch that ${"z".repeat(OVER_FLOOR_CHARS)}`);
		const info = tracker.getInterruptInfo(0, HIGH_VOLUME_THRESHOLD);
		expect(info?.reason).toBe("rumination");
	});

	it("reset() clears marker counts and tail state", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "wait actually hold on scratch that");
		expect(tracker.getMarkerCount(0)).toBe(4);
		tracker.reset();
		expect(tracker.getMarkerCount(0)).toBe(0);
		// A fresh split must not leak state from before the reset.
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "act");
		tracker.onThinkingDelta(0, "ually");
		expect(tracker.getMarkerCount(0)).toBe(1);
	});

	it("onThinkingStart clears per-block marker count", () => {
		const tracker = new OverthinkTracker();
		tracker.onThinkingStart(0);
		tracker.onThinkingDelta(0, "wait actually");
		tracker.onThinkingStart(0);
		expect(tracker.getMarkerCount(0)).toBe(0);
	});
});

describe("buildOverthinkReminderMessage (rumination)", () => {
	it("tailors the reminder text and attaches a non-enumerable marker count", () => {
		const message = buildOverthinkReminderMessage({
			estimatedTokens: 420,
			threshold: 1000,
			reason: "rumination",
			markerCount: 5,
		});
		expect((message as { _overthink_markers?: number })._overthink_markers).toBe(5);
		expect(JSON.stringify(message)).not.toContain("_overthink_markers");
		if (message.role !== "user") {
			throw new Error("expected user message");
		}
		const block = message.content[0];
		if (typeof block === "string" || block.type !== "text") {
			throw new Error("expected text block");
		}
		expect(block.text).toContain("[overthink]");
		expect(block.text).toContain("Detected 5 self-reversals");
		expect(isOverthinkSteerMessage(message)).toBe(true);
	});
});

describe("formatOverthinkSteerDisplayLine (rumination)", () => {
	it("formats from the tagged live reminder message", () => {
		const message = buildOverthinkReminderMessage({
			estimatedTokens: 420,
			threshold: 1000,
			reason: "rumination",
			markerCount: 6,
		});
		expect(formatOverthinkSteerDisplayLine(message)).toBe("Reasoning looped on 6 self-reversals. Model notified.");
	});

	it("formats from JSONL-restored text without runtime markers", () => {
		const message = {
			role: "user" as const,
			content: [
				{
					type: "text" as const,
					text: '<system-reminder>[overthink] Detected 7 self-reversals ("wait… actually…") within one reasoning block (~430 tokens). Act now.</system-reminder>',
				},
			],
			timestamp: Date.now(),
		};
		expect(formatOverthinkSteerDisplayLine(message)).toBe("Reasoning looped on 7 self-reversals. Model notified.");
		expect(isOverthinkSteerMessage(message)).toBe(true);
	});
});
