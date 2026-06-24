import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import { adaptivePruneThreshold, pruneOldToolOutputs } from "../src/core/compaction/compaction.js";

const PRUNE_TOKEN_THRESHOLD = 20_000;
const ADAPTIVE_PRUNE_MIN_THRESHOLD = 4_000;

/** A multi-line, non-JSON blob well above the head+tail excerpt budget so headTailExcerpt shrinks it. */
function bigBlob(head = "HEAD_MARKER", tail = "TAIL_MARKER"): string {
	return `${head}\n${"filler line\n".repeat(800)}${tail}`;
}

function readCall(id: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: args }],
		timestamp: 1,
	} as unknown as AgentMessage;
}

function readResult(toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	} as unknown as AgentMessage;
}

function user(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: 1 } as unknown as AgentMessage;
}

function textAt(messages: AgentMessage[], i: number): string {
	return (messages[i] as unknown as { content: { text: string }[] }).content[0].text;
}

describe("adaptivePruneThreshold", () => {
	it("returns the flat threshold at or below 50% occupancy (no early over-pruning)", () => {
		expect(adaptivePruneThreshold(0, 1_000_000)).toBe(PRUNE_TOKEN_THRESHOLD);
		expect(adaptivePruneThreshold(300_000, 1_000_000)).toBe(PRUNE_TOKEN_THRESHOLD);
		expect(adaptivePruneThreshold(500_000, 1_000_000)).toBe(PRUNE_TOKEN_THRESHOLD);
	});

	it("returns the flat threshold when the window is unknown/zero", () => {
		expect(adaptivePruneThreshold(900_000, 0)).toBe(PRUNE_TOKEN_THRESHOLD);
		expect(adaptivePruneThreshold(900_000, Number.NaN)).toBe(PRUNE_TOKEN_THRESHOLD);
	});

	it("reaches the floor at or above 90% occupancy", () => {
		expect(adaptivePruneThreshold(900_000, 1_000_000)).toBe(ADAPTIVE_PRUNE_MIN_THRESHOLD);
		expect(adaptivePruneThreshold(990_000, 1_000_000)).toBe(ADAPTIVE_PRUNE_MIN_THRESHOLD);
	});

	it("decreases monotonically between 50% and 90% occupancy", () => {
		const at60 = adaptivePruneThreshold(600_000, 1_000_000);
		const at70 = adaptivePruneThreshold(700_000, 1_000_000);
		const at80 = adaptivePruneThreshold(800_000, 1_000_000);
		expect(at60).toBeLessThan(PRUNE_TOKEN_THRESHOLD);
		expect(at60).toBeGreaterThan(at70);
		expect(at70).toBeGreaterThan(at80);
		expect(at80).toBeGreaterThan(ADAPTIVE_PRUNE_MIN_THRESHOLD);
	});
});

describe("pruneOldToolOutputs — superseded-read dedup", () => {
	it("collapses an older read of the same path even when below the size threshold", () => {
		const blob = bigBlob();
		const messages = [
			readCall("c1", { path: "foo.ts" }),
			readResult("c1", blob),
			readCall("c2", { path: "foo.ts" }),
			readResult("c2", "fresh content"),
			user("a"),
			user("b"),
		];

		// Flat 20k threshold: the old read is far below it, so ONLY the supersede
		// rule can reclaim it.
		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		expect(reclaimed).toBeGreaterThan(0);
		const old = textAt(messages, 1);
		expect(old.length).toBeLessThan(blob.length);
		expect(old).toContain("HEAD_MARKER");
		expect(old).toContain("TAIL_MARKER");
		expect(old).toContain("tokens elided");
		// The newest read of the same path is untouched.
		expect(textAt(messages, 3)).toBe("fresh content");
	});

	it("leaves a non-superseded read below the threshold untouched", () => {
		const blob = bigBlob();
		const messages = [readCall("c1", { path: "bar.ts" }), readResult("c1", blob), user("a"), user("b")];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(blob);
	});

	it("does not supersede reads of different ranges of the same file", () => {
		const blobA = bigBlob("HEAD_A", "TAIL_A");
		const blobB = bigBlob("HEAD_B", "TAIL_B");
		const messages = [
			readCall("c1", { path: "foo.ts", offset: 1, limit: 50 }),
			readResult("c1", blobA),
			readCall("c2", { path: "foo.ts", offset: 500, limit: 50 }),
			readResult("c2", blobB),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(blobA);
		expect(textAt(messages, 3)).toBe(blobB);
	});
});
