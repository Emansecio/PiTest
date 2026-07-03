import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import {
	adaptivePruneThreshold,
	applySupersedeOnly,
	pressurePruneProtectTurns,
	pruneOldToolOutputs,
} from "../src/core/compaction/compaction.js";

const PRUNE_TOKEN_THRESHOLD = 20_000;
const ADAPTIVE_PRUNE_MIN_THRESHOLD = 4_000;

/** A multi-line, non-JSON blob well above the head+tail excerpt budget so headTailExcerpt shrinks it. */
function bigBlob(head = "HEAD_MARKER", tail = "TAIL_MARKER"): string {
	return `${head}\n${"filler line\n".repeat(800)}${tail}`;
}

function toolCall(name: string, id: string, args: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		timestamp: 1,
	} as unknown as AgentMessage;
}

function toolResult(toolName: string, toolCallId: string, text: string, isError = false): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError,
		timestamp: 1,
	} as unknown as AgentMessage;
}

function readCall(id: string, args: Record<string, unknown>): AgentMessage {
	return toolCall("read", id, args);
}

function readResult(toolCallId: string, text: string): AgentMessage {
	return toolResult("read", toolCallId, text);
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

describe("pressurePruneProtectTurns", () => {
	it("reduces recent-turn protection under pressure on small-window models", () => {
		expect(pressurePruneProtectTurns(80_000, 128_000)).toBe(2);
		expect(pressurePruneProtectTurns(90_000, 128_000)).toBe(1);
		expect(pressurePruneProtectTurns(103_000, 128_000)).toBe(0);
	});

	it("keeps large-window sessions conservative until very high pressure", () => {
		expect(pressurePruneProtectTurns(300_000, 1_000_000)).toBe(2);
		expect(pressurePruneProtectTurns(950_000, 1_000_000)).toBe(1);
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

	it("collapses older repeated grep output below the size threshold", () => {
		const blob = bigBlob("GREP_HEAD", "GREP_TAIL");
		const args = { pattern: "foo", path: "src" };
		const messages = [
			toolCall("grep", "g1", args),
			toolResult("grep", "g1", blob),
			toolCall("grep", "g2", { path: "src", pattern: "foo" }),
			toolResult("grep", "g2", "fresh grep"),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).toContain("GREP_HEAD");
		expect(textAt(messages, 1)).toContain("GREP_TAIL");
		expect(textAt(messages, 3)).toBe("fresh grep");
	});

	it("collapses an older identical bash output even when below the size threshold", () => {
		const blob = bigBlob("BASH_HEAD", "BASH_TAIL");
		const args = { command: "npm test", cwd: "." };
		const messages = [
			toolCall("bash", "b1", args),
			toolResult("bash", "b1", blob),
			toolCall("bash", "b2", { cwd: ".", command: "npm test" }),
			toolResult("bash", "b2", "fresh bash"),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).toContain("BASH_HEAD");
		expect(textAt(messages, 1)).toContain("BASH_TAIL");
		expect(textAt(messages, 3)).toBe("fresh bash");
	});

	it("does not supersede different bash commands", () => {
		const blobA = bigBlob("CMD_A", "TAIL_A");
		const blobB = bigBlob("CMD_B", "TAIL_B");
		const messages = [
			toolCall("bash", "b1", { command: "npm test" }),
			toolResult("bash", "b1", blobA),
			toolCall("bash", "b2", { command: "npm run check" }),
			toolResult("bash", "b2", blobB),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(blobA);
		expect(textAt(messages, 3)).toBe(blobB);
	});

	it("can prune current-turn large outputs when protection is explicitly relaxed", () => {
		const big = `${"head\n"}${"x".repeat(90_000)}${"\ntail"}`;
		const messages = [user("current"), toolResult("bash", "b1", big)];

		const protectedReclaimed = pruneOldToolOutputs(messages, 1_000, 2);
		expect(protectedReclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(big);

		const reclaimed = pruneOldToolOutputs(messages, 1_000, 0);
		expect(reclaimed).toBeGreaterThan(0);
		expect(textAt(messages, 1)).toContain("tokens elided");
		expect(textAt(messages, 1)).toContain("head");
		expect(textAt(messages, 1)).toContain("tail");
	});
});

function elidedArg(messages: AgentMessage[], i: number, arg: string): string {
	const block = (messages[i] as unknown as { content: Array<{ arguments: Record<string, string> }> }).content[0];
	return block.arguments[arg];
}

describe("pruneOldToolOutputs — mutation-arg elision markers (failed vs applied)", () => {
	const bigBody = "const x = 1;\n".repeat(1_000); // ~13k chars, well above a 1k-token threshold

	it("uses the honest FAILED marker when the write's tool result errored", () => {
		const messages = [
			toolCall("write", "w1", { path: "foo.ts", content: bigBody }),
			toolResult("write", "w1", "Error: EACCES: permission denied", true),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, 1_000, 2);

		expect(reclaimed).toBeGreaterThan(0);
		const marker = elidedArg(messages, 0, "content");
		expect(marker).toContain("the write FAILED");
		expect(marker).toContain("NOT applied to disk");
		expect(marker).not.toContain("the file is the source of truth");
		// The error result itself is untouched.
		expect(textAt(messages, 1)).toBe("Error: EACCES: permission denied");
	});

	it("keeps the applied-to-disk marker when the write succeeded", () => {
		const messages = [
			toolCall("write", "w1", { path: "foo.ts", content: bigBody }),
			toolResult("write", "w1", "File written."),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, 1_000, 2);

		expect(reclaimed).toBeGreaterThan(0);
		const marker = elidedArg(messages, 0, "content");
		expect(marker).toContain("applied to disk; the file is the source of truth");
		expect(marker).not.toContain("FAILED");
	});
});

describe("supersede — the newest error result per resource is never collapsed", () => {
	it("keeps a superseded ERROR result intact while a later retry succeeds", () => {
		const errorBlob = bigBlob("ERROR_HEAD", "ERROR_TAIL");
		const messages = [
			readCall("c1", { path: "foo.ts" }),
			toolResult("read", "c1", errorBlob, true),
			readCall("c2", { path: "foo.ts" }),
			readResult("c2", "fresh content"),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		// The only supersede candidate is the newest error for this resource — protected.
		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(errorBlob);
		expect(textAt(messages, 3)).toBe("fresh content");
	});

	it("still collapses OLDER errors of the same resource, keeping only the newest error", () => {
		const oldError = bigBlob("OLD_ERR_HEAD", "OLD_ERR_TAIL");
		const newError = bigBlob("NEW_ERR_HEAD", "NEW_ERR_TAIL");
		const messages = [
			readCall("c1", { path: "foo.ts" }),
			toolResult("read", "c1", oldError, true),
			readCall("c2", { path: "foo.ts" }),
			toolResult("read", "c2", newError, true),
			readCall("c3", { path: "foo.ts" }),
			readResult("c3", "fresh content"),
			user("a"),
			user("b"),
		];

		const reclaimed = pruneOldToolOutputs(messages, PRUNE_TOKEN_THRESHOLD, 2);

		expect(reclaimed).toBeGreaterThan(0);
		// Oldest error collapsed to head+tail…
		expect(textAt(messages, 1).length).toBeLessThan(oldError.length);
		expect(textAt(messages, 1)).toContain("OLD_ERR_HEAD");
		// …but the newest error stays verbatim.
		expect(textAt(messages, 3)).toBe(newError);
		expect(textAt(messages, 5)).toBe("fresh content");
	});

	it("applySupersedeOnly honors the same protection", () => {
		const errorBlob = bigBlob("ERROR_HEAD", "ERROR_TAIL");
		const messages = [
			readCall("c1", { path: "foo.ts" }),
			toolResult("read", "c1", errorBlob, true),
			readCall("c2", { path: "foo.ts" }),
			readResult("c2", "fresh content"),
			user("a"),
			user("b"),
		];

		const reclaimed = applySupersedeOnly(messages, 2);

		expect(reclaimed).toBe(0);
		expect(textAt(messages, 1)).toBe(errorBlob);
	});
});
