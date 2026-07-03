import type { AgentMessage } from "@pit/agent-core";
import { describe, expect, it } from "vitest";
import { prepareBranchEntries } from "../src/core/compaction/branch-summarization.js";
import { estimateTokens } from "../src/core/compaction/compaction.js";
import type { SessionEntry } from "../src/core/session-manager.js";

// M16 — branch summarization must budget each entry by the SERIALIZED form its
// prompt actually consumes (serializeConversation caps tool-call args, thinking,
// and tool-result text), not the raw per-message estimate. Otherwise a single
// large write/edit body fills the window many times over its real prompt cost.

function assistantWrite(path: string, body: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: "tc", name: "write", arguments: { path, content: body } }],
	} as unknown as AgentMessage;
}

function userMsg(text: string): AgentMessage {
	return { role: "user", content: text } as unknown as AgentMessage;
}

function msgEntry(message: AgentMessage, i: number): SessionEntry {
	return {
		type: "message",
		id: `m${i}`,
		parentId: i === 0 ? null : `m${i - 1}`,
		timestamp: new Date().toISOString(),
		message,
	} as unknown as SessionEntry;
}

function compactionEntry(summary: string, i: number): SessionEntry {
	return {
		type: "compaction",
		id: `c${i}`,
		parentId: null,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId: "x",
		tokensBefore: 0,
	} as unknown as SessionEntry;
}

/** Replays the pre-M16 raw-estimate walk to prove the serialized walk covers more. */
function rawBudgetCount(entries: SessionEntry[], budget: number): number {
	let total = 0;
	let count = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const t = estimateTokens((entries[i] as unknown as { message: AgentMessage }).message);
		if (total + t > budget) break;
		total += t;
		count++;
	}
	return count;
}

describe("M16 branch summary budget over serialized form", () => {
	it("covers far more tool-call-heavy history than the raw estimate under the same budget", () => {
		const bigBody = "X".repeat(8000);
		const entries = Array.from({ length: 6 }, (_, i) => msgEntry(assistantWrite(`src/file${i}.ts`, bigBody), i));
		const budget = 1000;

		// Raw estimate: the write body alone (~2400 tokens) blows the whole budget,
		// so the pre-M16 walk fits ZERO of these entries.
		expect(estimateTokens(assistantWrite("src/file0.ts", bigBody))).toBeGreaterThan(budget);
		expect(rawBudgetCount(entries, budget)).toBe(0);

		// Serialized form caps each write arg to ~300 chars, so all six now fit.
		const prep = prepareBranchEntries(entries, budget);
		expect(prep.messages.length).toBe(6);
		expect(prep.messages.length).toBeGreaterThan(rawBudgetCount(entries, budget));
		expect(prep.totalTokens).toBeLessThanOrEqual(budget);
	});

	it("still lets compaction entries breach the budget up to 90% (override preserved)", () => {
		const budget = 1000;
		const small = "word ".repeat(20); // ~100 chars → well under 90% of budget
		const users = Array.from({ length: 3 }, (_, i) => msgEntry(userMsg(small), i + 1));
		// Oversized compaction summary: alone it exceeds the remaining budget.
		const comp = compactionEntry("S".repeat(4000), 0);
		const entries = [comp, ...users]; // chronological: compaction is oldest

		const prep = prepareBranchEntries(entries, budget);

		// The walk was still below 90% when it reached the compaction, so it was
		// squeezed in even though that pushed the total over budget.
		const hasCompaction = prep.messages.some((m) => (m as { role: string }).role === "compactionSummary");
		expect(hasCompaction).toBe(true);
		expect(prep.totalTokens).toBeGreaterThan(budget);
	});

	it("does NOT breach the budget for a plain (non-summary) entry", () => {
		const budget = 1000;
		const small = "word ".repeat(20);
		const users = Array.from({ length: 3 }, (_, i) => msgEntry(userMsg(small), i + 1));
		// Same oversized payload as a plain user message instead of a compaction entry.
		const big = msgEntry(userMsg("S".repeat(4000)), 0);
		const entries = [big, ...users];

		const prep = prepareBranchEntries(entries, budget);

		// A plain message that would exceed the budget is dropped (no 90% override).
		expect(prep.totalTokens).toBeLessThanOrEqual(budget);
		expect(prep.messages.length).toBe(3);
	});
});
