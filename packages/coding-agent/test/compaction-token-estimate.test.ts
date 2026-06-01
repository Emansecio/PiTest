/**
 * Tests for content-sensitive token estimation in compaction.
 */

import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, test } from "vitest";
import { estimateTextTokens, estimateTokens, findCutPoint } from "../src/core/compaction/compaction.js";
import type { SessionEntry } from "../src/core/session-manager.js";

// ---------------------------------------------------------------------------
// estimateTextTokens
// ---------------------------------------------------------------------------

describe("estimateTextTokens", () => {
	test("pure prose uses ~4 chars/token", () => {
		const prose = "Hello world this is a sentence with no symbols at all whatsoever";
		const tokens = estimateTextTokens(prose);
		// chars/4 rounded up
		expect(tokens).toBe(Math.ceil(prose.length / 4));
	});

	test("dense text (JSON) uses fewer chars per token than prose", () => {
		const len = 1000;
		const prose = "a".repeat(len);
		const dense = '{"key":"value","arr":[1,2,3],"nested":{"x":true}}'.repeat(Math.ceil(len / 50)).slice(0, len);

		const proseTokens = estimateTextTokens(prose);
		const denseTokens = estimateTextTokens(dense);
		// dense should yield MORE tokens for same char count
		expect(denseTokens).toBeGreaterThan(proseTokens);
	});

	test("forceDense flag overrides classification", () => {
		const text = "plain prose text with no symbols";
		const normal = estimateTextTokens(text);
		const forced = estimateTextTokens(text, true);
		// forceDense uses 3.3 divisor → more tokens
		expect(forced).toBeGreaterThanOrEqual(normal);
		expect(forced).toBe(Math.ceil(text.length / 3.3));
	});

	test("empty string returns 0", () => {
		expect(estimateTextTokens("")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

function makeUserMsg(text: string): AgentMessage {
	return { role: "user", content: text } as AgentMessage;
}

function makeToolResultMsg(text: string): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
	} as unknown as AgentMessage;
}

function makeImageToolResultMsg(): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "" } }],
	} as unknown as AgentMessage;
}

describe("estimateTokens", () => {
	test("accepts 1 argument (backward-compat)", () => {
		const msg = makeUserMsg("hello world");
		expect(() => estimateTokens(msg)).not.toThrow();
		expect(typeof estimateTokens(msg)).toBe("number");
	});

	test("dense content (tool result) estimates more tokens than same-length prose", () => {
		const len = 400;
		const prose = makeUserMsg("word ".repeat(Math.ceil(len / 5)).slice(0, len));
		const dense = makeToolResultMsg('{"k":"v","arr":[1,2,3],"n":true}'.repeat(Math.ceil(len / 33)).slice(0, len));

		const proseTokens = estimateTokens(prose);
		const denseTokens = estimateTokens(dense);
		expect(denseTokens).toBeGreaterThan(proseTokens);
	});

	test("image block counts as 1200 tokens", () => {
		const imgMsg = makeImageToolResultMsg();
		expect(estimateTokens(imgMsg)).toBe(1200);
	});

	test("pure prose ≈ chars/4", () => {
		const text = "the quick brown fox jumps over the lazy dog ".repeat(5);
		const msg = makeUserMsg(text);
		expect(estimateTokens(msg)).toBe(Math.ceil(text.length / 4));
	});

	test("cache: calling twice returns identical result", () => {
		const msg = makeUserMsg("some text here for caching test");
		const first = estimateTokens(msg);
		const second = estimateTokens(msg);
		expect(first).toBe(second);
	});
});

// ---------------------------------------------------------------------------
// findCutPoint: dense content is heavier than prose
// ---------------------------------------------------------------------------

function makeEntry(msg: AgentMessage): SessionEntry {
	return { type: "message", id: Math.random().toString(36).slice(2), message: msg } as unknown as SessionEntry;
}

describe("findCutPoint", () => {
	test("dense entries reach keepRecentTokens budget with fewer messages than prose", () => {
		const msgLen = 400;
		const count = 10;

		// All prose entries
		const proseEntries: SessionEntry[] = Array.from({ length: count }, (_, i) =>
			makeEntry({
				role: i % 2 === 0 ? "user" : "assistant",
				content:
					i % 2 === 0
						? "word ".repeat(Math.ceil(msgLen / 5)).slice(0, msgLen)
						: [{ type: "text", text: "word ".repeat(Math.ceil(msgLen / 5)).slice(0, msgLen) }],
			} as unknown as AgentMessage),
		);

		// All dense entries (JSON content)
		const denseEntries: SessionEntry[] = Array.from({ length: count }, (_, i) =>
			makeEntry({
				role: i % 2 === 0 ? "user" : "assistant",
				content:
					i % 2 === 0
						? '{"k":"v","arr":[1,2,3],"n":true}'.repeat(Math.ceil(msgLen / 33)).slice(0, msgLen)
						: [
								{
									type: "text",
									text: '{"k":"v","arr":[1,2,3],"n":true}'.repeat(Math.ceil(msgLen / 33)).slice(0, msgLen),
								},
							],
			} as unknown as AgentMessage),
		);

		const budget = 800; // tokens to keep

		const proseResult = findCutPoint(proseEntries, 0, proseEntries.length, budget);
		const denseResult = findCutPoint(denseEntries, 0, denseEntries.length, budget);

		// Dense messages are heavier → cut point must be further right (fewer messages kept)
		// i.e., firstKeptEntryIndex for dense >= firstKeptEntryIndex for prose
		expect(denseResult.firstKeptEntryIndex).toBeGreaterThanOrEqual(proseResult.firstKeptEntryIndex);
	});
});
