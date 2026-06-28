import type { AgentMessage } from "@pit/agent-core";
import type { AssistantMessage, Usage } from "@pit/ai";
import { getModel } from "@pit/ai";
import { readFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CompactionPreparation,
	type CompactionSettings,
	calculateContextTokens,
	cloneToolResultMessagesForPrune,
	compact,
	computeDynamicReserve,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	findCutPoint,
	getLastAssistantUsage,
	prepareCompaction,
	proactivePruneFloor,
	pruneOldToolOutputs,
	shouldCompact,
	shouldCompactSoft,
} from "../src/core/compaction/index.js";
import { createDeferredOutputStore, setCurrentDeferredOutputStore } from "../src/core/deferred-output-store.js";
import {
	buildSessionContext,
	type CompactionEntry,
	type ModelChangeEntry,
	migrateSessionEntries,
	parseSessionEntries,
	type SessionEntry,
	type SessionMessageEntry,
	type ThinkingLevelChangeEntry,
} from "../src/core/session-manager.js";

// ============================================================================
// Test fixtures
// ============================================================================

function loadLargeSessionEntries(): SessionEntry[] {
	const sessionPath = join(__dirname, "fixtures/large-session.jsonl");
	const content = readFileSync(sessionPath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries); // Add id/parentId for v1 fixtures
	return entries.filter((e): e is SessionEntry => e.type !== "session");
}

function createMockUsage(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string, usage?: Usage): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: usage || createMockUsage(100, 50),
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

let entryCounter = 0;
let lastId: string | null = null;

function resetEntryCounter() {
	entryCounter = 0;
	lastId = null;
}

// Reset counter before each test to get predictable IDs
beforeEach(() => {
	resetEntryCounter();
});

function createMessageEntry(message: AgentMessage): SessionMessageEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: SessionMessageEntry = {
		type: "message",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		message,
	};
	lastId = id;
	return entry;
}

function createCompactionEntry(summary: string, firstKeptEntryId: string): CompactionEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: CompactionEntry = {
		type: "compaction",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		summary,
		firstKeptEntryId,
		tokensBefore: 10000,
	};
	lastId = id;
	return entry;
}

function createModelChangeEntry(provider: string, modelId: string): ModelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ModelChangeEntry = {
		type: "model_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		provider,
		modelId,
	};
	lastId = id;
	return entry;
}

function createThinkingLevelEntry(thinkingLevel: string): ThinkingLevelChangeEntry {
	const id = `test-id-${entryCounter++}`;
	const entry: ThinkingLevelChangeEntry = {
		type: "thinking_level_change",
		id,
		parentId: lastId,
		timestamp: new Date().toISOString(),
		thinkingLevel,
	};
	lastId = id;
	return entry;
}

function extractText(messages: AgentMessage[]): string {
	return messages
		.map((message) => {
			switch (message.role) {
				case "user":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "assistant":
					return message.content
						.filter((block): block is { type: "text"; text: string } => block.type === "text")
						.map((block) => block.text)
						.join(" ");
				case "branchSummary":
				case "compactionSummary":
					return message.summary;
				case "custom":
				case "toolResult":
					return typeof message.content === "string"
						? message.content
						: message.content
								.filter((block): block is { type: "text"; text: string } => block.type === "text")
								.map((block) => block.text)
								.join(" ");
				case "bashExecution":
					return `${message.command}\n${message.output}`;
				default:
					return "";
			}
		})
		.join("\n");
}

// ============================================================================
// Unit tests
// ============================================================================

describe("Token calculation", () => {
	it("should calculate total context tokens from usage", () => {
		const usage = createMockUsage(1000, 500, 200, 100);
		expect(calculateContextTokens(usage)).toBe(1800);
	});

	it("should handle zero values", () => {
		const usage = createMockUsage(0, 0, 0, 0);
		expect(calculateContextTokens(usage)).toBe(0);
	});
});

describe("getLastAssistantUsage", () => {
	it("should find the last non-aborted assistant message usage", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(createAssistantMessage("Good", createMockUsage(200, 100))),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(200);
	});

	it("should skip aborted messages", () => {
		const abortedMsg: AssistantMessage = {
			...createAssistantMessage("Aborted", createMockUsage(300, 150)),
			stopReason: "aborted",
		};

		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Hello")),
			createMessageEntry(createAssistantMessage("Hi", createMockUsage(100, 50))),
			createMessageEntry(createUserMessage("How are you?")),
			createMessageEntry(abortedMsg),
		];

		const usage = getLastAssistantUsage(entries);
		expect(usage).not.toBeNull();
		expect(usage!.input).toBe(100);
	});

	it("should return undefined if no assistant messages", () => {
		const entries: SessionEntry[] = [createMessageEntry(createUserMessage("Hello"))];
		expect(getLastAssistantUsage(entries)).toBeUndefined();
	});
});

describe("shouldCompact", () => {
	it("should return true when context exceeds threshold", () => {
		const settings: CompactionSettings = {
			enabled: true,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(true);
		expect(shouldCompact(89000, 100000, settings)).toBe(false);
	});

	it("should return false when disabled", () => {
		const settings: CompactionSettings = {
			enabled: false,
			reserveTokens: 10000,
			keepRecentTokens: 20000,
		};

		expect(shouldCompact(95000, 100000, settings)).toBe(false);
	});
});

describe("computeDynamicReserve", () => {
	it("uses 10% of the window for small windows (≤200k)", () => {
		// configured reserve below the 10% floor → floor wins
		expect(computeDynamicReserve(100_000, 5_000)).toBe(10_000);
		expect(computeDynamicReserve(200_000, 16_384)).toBe(20_000);
		// configured reserve above the 10% floor → configured wins
		expect(computeDynamicReserve(100_000, 30_000)).toBe(30_000);
	});

	it("caps reserve on tiny model windows so the threshold remains usable", () => {
		expect(computeDynamicReserve(8_192, 16_384)).toBe(4_096);
		expect(shouldCompact(3_000, 8_192, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompact(5_000, 8_192, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
	});

	it("does not compact when a model has no usable context window metadata", () => {
		expect(computeDynamicReserve(0, 16_384)).toBe(0);
		expect(shouldCompact(1, 0, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
		expect(shouldCompactSoft(1, 0, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
	});

	it("keeps a 20k floor just above 200k where 2.5% is still small", () => {
		// 2.5% of 200_001 ≈ 5000 < 20k → 20k floor. Continuous with the ≤200k branch.
		expect(computeDynamicReserve(200_001, 16_384)).toBe(20_000);
		expect(computeDynamicReserve(400_000, 16_384)).toBe(20_000); // 2.5% = 10k < 20k
	});

	it("applies the 2.5% floor for very large windows (regression: was a flat 20k)", () => {
		// 1M window: flat 20k would be 2% (trigger ~98%); 2.5% = 25k (~97.5%).
		expect(computeDynamicReserve(1_000_000, 16_384)).toBe(25_000);
		// configured reserve still wins when larger than both floors
		expect(computeDynamicReserve(1_000_000, 40_000)).toBe(40_000);
	});
});

describe("proactivePruneFloor", () => {
	it("keeps the 64k floor for small/normal windows (≤256k)", () => {
		expect(proactivePruneFloor(128_000)).toBe(64_000);
		expect(proactivePruneFloor(200_000)).toBe(64_000);
		expect(proactivePruneFloor(256_000)).toBe(64_000); // 25% == 64k, boundary
	});

	it("scales to 25% of the window for large windows (>256k)", () => {
		expect(proactivePruneFloor(400_000)).toBe(100_000);
		expect(proactivePruneFloor(1_000_000)).toBe(250_000);
	});

	it("lets a positive explicit override win", () => {
		expect(proactivePruneFloor(1_000_000, 80_000)).toBe(80_000);
		expect(proactivePruneFloor(128_000, 30_000)).toBe(30_000);
	});

	it("ignores a non-positive or non-finite override", () => {
		expect(proactivePruneFloor(128_000, 0)).toBe(64_000);
		expect(proactivePruneFloor(128_000, -5)).toBe(64_000);
		expect(proactivePruneFloor(128_000, Number.NaN)).toBe(64_000);
	});

	it("falls back to the 64k floor for a zero/invalid window", () => {
		expect(proactivePruneFloor(0)).toBe(64_000);
		expect(proactivePruneFloor(Number.NaN)).toBe(64_000);
	});
});

describe("shouldCompactSoft", () => {
	// window 100k, reserve 10k → hard threshold 90k; keepRecent 20k → soft 70k.
	const settings: CompactionSettings = { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 };

	it("fires between the soft and hard thresholds", () => {
		expect(shouldCompactSoft(75_000, 100_000, settings)).toBe(true); // 70k < 75k < 90k
		expect(shouldCompactSoft(71_000, 100_000, settings)).toBe(true);
	});

	it("does not fire below the soft threshold", () => {
		expect(shouldCompactSoft(65_000, 100_000, settings)).toBe(false);
		expect(shouldCompactSoft(70_000, 100_000, settings)).toBe(false); // strict >
	});

	it("hands off above the hard threshold (synchronous path owns it)", () => {
		// At exactly the hard threshold the hard check (strict >) has NOT fired yet,
		// so soft legitimately covers it — no gap, no overlap.
		expect(shouldCompactSoft(90_000, 100_000, settings)).toBe(true);
		expect(shouldCompact(90_000, 100_000, settings)).toBe(false);
		// Strictly above the hard threshold → soft yields to the synchronous path.
		expect(shouldCompactSoft(90_001, 100_000, settings)).toBe(false);
		expect(shouldCompactSoft(95_000, 100_000, settings)).toBe(false);
	});

	it("widens the predictive band on large windows via effectiveKeepRecentTokens", () => {
		// 1M window: reserve = max(16384, 20000, 2.5%=25000) = 25000 → hard threshold 975k.
		// The soft band scales to 10% retention (100k), NOT the raw 20k, so soft threshold = 875k.
		const big: CompactionSettings = { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 };
		expect(shouldCompactSoft(880_000, 1_000_000, big)).toBe(true); // 875k < 880k < 975k
		expect(shouldCompactSoft(860_000, 1_000_000, big)).toBe(false); // below the scaled soft band
		expect(shouldCompactSoft(976_000, 1_000_000, big)).toBe(false); // above hard → sync path owns it
		// ≤200k windows are byte-identical (effectiveKeepRecentTokens returns the raw 20k).
		expect(shouldCompactSoft(75_000, 100_000, big)).toBe(true);
	});

	it("returns false when disabled", () => {
		expect(shouldCompactSoft(75_000, 100_000, { ...settings, enabled: false })).toBe(false);
	});

	it("fires before the hard trigger on the same usage (predictive lead)", () => {
		// 80k: soft fires (background) while hard does NOT yet — the whole point.
		expect(shouldCompactSoft(80_000, 100_000, settings)).toBe(true);
		expect(shouldCompact(80_000, 100_000, settings)).toBe(false);
	});
});

describe("findCutPoint", () => {
	it("should find cut point based on actual token differences", () => {
		// Create entries with cumulative token counts
		const entries: SessionEntry[] = [];
		for (let i = 0; i < 10; i++) {
			entries.push(createMessageEntry(createUserMessage(`User ${i}`)));
			entries.push(
				createMessageEntry(createAssistantMessage(`Assistant ${i}`, createMockUsage(0, 100, (i + 1) * 1000, 0))),
			);
		}

		// 20 entries, last assistant has 10000 tokens
		// keepRecentTokens = 2500: keep entries where diff < 2500
		const result = findCutPoint(entries, 0, entries.length, 2500);

		// Should cut at a valid cut point (user or assistant message)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should return startIndex if no valid cut points in range", () => {
		const entries: SessionEntry[] = [createMessageEntry(createAssistantMessage("a"))];
		const result = findCutPoint(entries, 0, entries.length, 1000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should keep everything if all messages fit within budget", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a", createMockUsage(0, 50, 500, 0))),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b", createMockUsage(0, 50, 1000, 0))),
		];

		const result = findCutPoint(entries, 0, entries.length, 50000);
		expect(result.firstKeptEntryIndex).toBe(0);
	});

	it("should indicate split turn when cutting at assistant message", () => {
		// Create a scenario where we cut at an assistant message mid-turn
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("Turn 1")),
			createMessageEntry(createAssistantMessage("A1", createMockUsage(0, 100, 1000, 0))),
			createMessageEntry(createUserMessage("Turn 2")), // index 2
			createMessageEntry(createAssistantMessage("A2-1", createMockUsage(0, 100, 5000, 0))), // index 3
			createMessageEntry(createAssistantMessage("A2-2", createMockUsage(0, 100, 8000, 0))), // index 4
			createMessageEntry(createAssistantMessage("A2-3", createMockUsage(0, 100, 10000, 0))), // index 5
		];

		// With keepRecentTokens = 3000, should cut somewhere in Turn 2
		const result = findCutPoint(entries, 0, entries.length, 3000);

		// If cut at assistant message (not user), should indicate split turn
		const cutEntry = entries[result.firstKeptEntryIndex] as SessionMessageEntry;
		if (cutEntry.message.role === "assistant") {
			expect(result.isSplitTurn).toBe(true);
			expect(result.turnStartIndex).toBe(2); // Turn 2 starts at index 2
		}
	});
});

describe("buildSessionContext", () => {
	it("should load all messages when no compaction", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createMessageEntry(createAssistantMessage("a")),
			createMessageEntry(createUserMessage("2")),
			createMessageEntry(createAssistantMessage("b")),
		];

		const loaded = buildSessionContext(entries);
		expect(loaded.messages.length).toBe(4);
		expect(loaded.thinkingLevel).toBe("off");
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
	});

	it("should handle single compaction", () => {
		// IDs: u1=test-id-0, a1=test-id-1, u2=test-id-2, a2=test-id-3, compaction=test-id-4, u3=test-id-5, a3=test-id-6
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const u2 = createMessageEntry(createUserMessage("2"));
		const a2 = createMessageEntry(createAssistantMessage("b"));
		const compaction = createCompactionEntry("Summary of 1,a,2,b", u2.id); // keep from u2 onwards
		const u3 = createMessageEntry(createUserMessage("3"));
		const a3 = createMessageEntry(createAssistantMessage("c"));

		const entries: SessionEntry[] = [u1, a1, u2, a2, compaction, u3, a3];

		const loaded = buildSessionContext(entries);
		// summary + kept (u2, a2) + after (u3, a3) = 5
		expect(loaded.messages.length).toBe(5);
		expect(loaded.messages[0].role).toBe("compactionSummary");
		expect((loaded.messages[0] as any).summary).toContain("Summary of 1,a,2,b");
	});

	it("should handle multiple compactions (only latest matters)", () => {
		// First batch
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id);
		// Second batch
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));
		const u3 = createMessageEntry(createUserMessage("3"));
		const c = createMessageEntry(createAssistantMessage("c"));
		const compact2 = createCompactionEntry("Second summary", u3.id); // keep from u3 onwards
		// After second compaction
		const u4 = createMessageEntry(createUserMessage("4"));
		const d = createMessageEntry(createAssistantMessage("d"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b, u3, c, compact2, u4, d];

		const loaded = buildSessionContext(entries);
		// summary + kept from u3 (u3, c) + after (u4, d) = 5
		expect(loaded.messages.length).toBe(5);
		expect((loaded.messages[0] as any).summary).toContain("Second summary");
	});

	it("should keep all messages when firstKeptEntryId is first entry", () => {
		const u1 = createMessageEntry(createUserMessage("1"));
		const a1 = createMessageEntry(createAssistantMessage("a"));
		const compact1 = createCompactionEntry("First summary", u1.id); // keep from first entry
		const u2 = createMessageEntry(createUserMessage("2"));
		const b = createMessageEntry(createAssistantMessage("b"));

		const entries: SessionEntry[] = [u1, a1, compact1, u2, b];

		const loaded = buildSessionContext(entries);
		// summary + all messages (u1, a1, u2, b) = 5
		expect(loaded.messages.length).toBe(5);
	});

	it("should track model and thinking level changes", () => {
		const entries: SessionEntry[] = [
			createMessageEntry(createUserMessage("1")),
			createModelChangeEntry("openai", "gpt-4"),
			createMessageEntry(createAssistantMessage("a")),
			createThinkingLevelEntry("high"),
		];

		const loaded = buildSessionContext(entries);
		// model_change is later overwritten by assistant message's model info
		expect(loaded.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
		expect(loaded.thinkingLevel).toBe("high");
	});
});

describe("prepareCompaction with previous compaction", () => {
	it("should preserve kept messages across repeated compactions when they still fit", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)"));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1"));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1"));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2"));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1"));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3", createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1)"));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4", createMockUsage(8000, 2000)));

		const pathEntries = [u1, a1, u2, a2, u3, a3, compaction1, u4, a4];
		const contextBefore = buildSessionContext(pathEntries);
		const preparation = prepareCompaction(pathEntries, DEFAULT_COMPACTION_SETTINGS);

		expect(preparation).toBeDefined();
		expect(preparation!.firstKeptEntryId).toBe(u2.id);
		expect(preparation!.previousSummary).toBe("First summary");
		expect(extractText(preparation!.messagesToSummarize)).not.toContain("First summary");
		expect(preparation!.tokensBefore).toBe(estimateContextTokens(contextBefore.messages).tokens);

		const compaction2: CompactionEntry = {
			type: "compaction",
			id: "compaction2-id",
			parentId: a4.id,
			timestamp: new Date().toISOString(),
			summary: "Second summary",
			firstKeptEntryId: preparation!.firstKeptEntryId,
			tokensBefore: preparation!.tokensBefore,
		};
		const contextAfter = buildSessionContext([...pathEntries, compaction2]);
		const contextAfterText = extractText(contextAfter.messages);

		expect(contextAfterText).toContain("user msg 2 - kept by compaction1");
		expect(contextAfterText).toContain("user msg 3 - kept by compaction1");
	});

	it("should re-summarize previously kept messages when the recent window moves past them", () => {
		const u1 = createMessageEntry(createUserMessage("user msg 1 (summarized by compaction1)".repeat(4)));
		const a1 = createMessageEntry(createAssistantMessage("assistant msg 1".repeat(4)));
		const u2 = createMessageEntry(createUserMessage("user msg 2 - kept by compaction1 ".repeat(12)));
		const a2 = createMessageEntry(createAssistantMessage("assistant msg 2 ".repeat(12)));
		const u3 = createMessageEntry(createUserMessage("user msg 3 - kept by compaction1 ".repeat(12)));
		const a3 = createMessageEntry(createAssistantMessage("assistant msg 3 ".repeat(12), createMockUsage(5000, 1000)));
		const compaction1 = createCompactionEntry("First summary", u2.id);
		const u4 = createMessageEntry(createUserMessage("user msg 4 (new after compaction1) ".repeat(12)));
		const a4 = createMessageEntry(createAssistantMessage("assistant msg 4 ".repeat(12), createMockUsage(8000, 2000)));

		const settings: CompactionSettings = {
			...DEFAULT_COMPACTION_SETTINGS,
			keepRecentTokens: 100,
		};
		const preparation = prepareCompaction([u1, a1, u2, a2, u3, a3, compaction1, u4, a4], settings);

		expect(preparation).toBeDefined();
		const summarizedText = extractText(preparation!.messagesToSummarize);
		expect(summarizedText).toContain("user msg 2 - kept by compaction1");
		expect(summarizedText).toContain("user msg 3 - kept by compaction1");
		expect(summarizedText).not.toContain("First summary");
		expect(preparation!.previousSummary).toBe("First summary");
	});
});

// ============================================================================
// Integration tests with real session data
// ============================================================================

describe("Large session fixture", () => {
	it("should parse the large session", () => {
		const entries = loadLargeSessionEntries();
		expect(entries.length).toBeGreaterThan(100);

		const messageCount = entries.filter((e) => e.type === "message").length;
		expect(messageCount).toBeGreaterThan(100);
	});

	it("should find cut point in large session", () => {
		const entries = loadLargeSessionEntries();
		const result = findCutPoint(entries, 0, entries.length, DEFAULT_COMPACTION_SETTINGS.keepRecentTokens);

		// Cut point should be at a message entry (user or assistant)
		expect(entries[result.firstKeptEntryIndex].type).toBe("message");
		const role = (entries[result.firstKeptEntryIndex] as SessionMessageEntry).message.role;
		expect(role === "user" || role === "assistant").toBe(true);
	});

	it("should load session correctly", () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);

		expect(loaded.messages.length).toBeGreaterThan(100);
		expect(loaded.model).not.toBeNull();
	});
});

// ============================================================================
// LLM integration tests (skipped without API key)
// ============================================================================

describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("LLM summarization", () => {
	it("should generate a compaction result for the large session", async () => {
		const entries = loadLargeSessionEntries();
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		expect(compactionResult.summary.length).toBeGreaterThan(100);
		expect(compactionResult.firstKeptEntryId).toBeTruthy();
		expect(compactionResult.tokensBefore).toBeGreaterThan(0);

		console.log("Summary length:", compactionResult.summary.length);
		console.log("First kept entry ID:", compactionResult.firstKeptEntryId);
		console.log("Tokens before:", compactionResult.tokensBefore);
		console.log("\n--- SUMMARY ---\n");
		console.log(compactionResult.summary);
	}, 60000);

	it("should produce valid session after compaction", async () => {
		const entries = loadLargeSessionEntries();
		const loaded = buildSessionContext(entries);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;

		const preparation = prepareCompaction(entries, DEFAULT_COMPACTION_SETTINGS);
		expect(preparation).toBeDefined();

		const compactionResult = await compact(preparation!, model, process.env.ANTHROPIC_OAUTH_TOKEN!);

		// Simulate appending compaction to entries by creating a proper entry
		const lastEntry = entries[entries.length - 1];
		const parentId = lastEntry.id;
		const compactionEntry: CompactionEntry = {
			type: "compaction",
			id: "compaction-test-id",
			parentId,
			timestamp: new Date().toISOString(),
			...compactionResult,
		};
		const newEntries = [...entries, compactionEntry];
		const reloaded = buildSessionContext(newEntries);

		// Should have summary + kept messages
		expect(reloaded.messages.length).toBeLessThan(loaded.messages.length);
		expect(reloaded.messages[0].role).toBe("compactionSummary");
		expect((reloaded.messages[0] as any).summary).toContain(compactionResult.summary);

		console.log("Original messages:", loaded.messages.length);
		console.log("After compaction:", reloaded.messages.length);
	}, 60000);
});

// ============================================================================
// pruneOldToolOutputs — deferred-history flag tests
// ============================================================================

describe("pruneOldToolOutputs deferred-history mode", () => {
	afterEach(() => {
		delete process.env.PIT_DEFER_HISTORY;
		setCurrentDeferredOutputStore(undefined);
	});

	function makeToolResultMessage(text: string): AgentMessage {
		return {
			role: "toolResult" as const,
			content: [{ type: "text" as const, text }],
			timestamp: Date.now(),
			toolCallId: "tc-test",
		} as any;
	}

	it("with defer=true and a store, large output keeps a head+tail excerpt plus a recall id (hybrid)", () => {
		const store = createDeferredOutputStore();
		setCurrentDeferredOutputStore(store);

		const bigText = "x".repeat(90_000); // ~27k tokens (dense) >> 20k threshold
		const userMsg: AgentMessage = { role: "user" as const, content: "q", timestamp: Date.now() };
		const assistantMsg: AgentMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "a" }],
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		} as any;

		// Two old tool-result messages before protected turns
		const toolResult = makeToolResultMessage(bigText);
		const messages: AgentMessage[] = [toolResult, userMsg, assistantMsg, userMsg, assistantMsg];

		pruneOldToolOutputs(messages, undefined, undefined, true);

		const replaced = (messages[0] as any).content[0].text as string;
		expect(replaced).toContain("recall_tool_output");
		expect(replaced).not.toContain("pruned");
		// Hybrid keeps the output's shape inline alongside the recall pointer.
		expect(replaced).toContain("tokens elided");
		expect(replaced.startsWith("xxx")).toBe(true);

		// Extract id from the recall footer and confirm the FULL text is recoverable.
		const match = replaced.match(/id: "(\w+)"/);
		expect(match).toBeTruthy();
		const id = match![1];
		expect(store.get(id)).toBe(bigText);

		store.dispose();
	});

	it("without PIT_DEFER_HISTORY, large output is shrunk to a head+tail excerpt", () => {
		delete process.env.PIT_DEFER_HISTORY;

		const bigText = "y".repeat(90_000);
		const userMsg: AgentMessage = { role: "user" as const, content: "q", timestamp: Date.now() };
		const assistantMsg: AgentMessage = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "a" }],
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		} as any;

		const toolResult = makeToolResultMessage(bigText);
		const messages: AgentMessage[] = [toolResult, userMsg, assistantMsg, userMsg, assistantMsg];

		pruneOldToolOutputs(messages);

		const replaced = (messages[0] as any).content[0].text as string;
		// Head/tail excerpt: much shorter than the original, marks the elision,
		// keeps actual content, and is NOT the deferred placeholder.
		expect(replaced).toContain("tokens elided");
		expect(replaced).not.toContain("recall_tool_output");
		expect(replaced.length).toBeLessThan(bigText.length / 10);
		expect(replaced.startsWith("yyy")).toBe(true);
	});

	it("head+tail excerpt preserves the first and last lines of a structured output", () => {
		delete process.env.PIT_DEFER_HISTORY;

		// A grep-like output: distinctive first and last lines, bulky middle.
		const lines = ["FIRST match: src/a.ts:1"];
		for (let i = 0; i < 4000; i++) lines.push(`mid match: src/file${i}.ts:${i} ${"x".repeat(20)}`);
		lines.push("LAST match: src/z.ts:9999");
		const bigText = lines.join("\n");

		const userMsg: AgentMessage = { role: "user" as const, content: "q", timestamp: Date.now() };
		const assistantMsg = createAssistantMessage("a");
		const toolResult = makeToolResultMessage(bigText);
		const messages: AgentMessage[] = [toolResult, userMsg, assistantMsg, userMsg, assistantMsg];

		pruneOldToolOutputs(messages);

		const replaced = (messages[0] as any).content[0].text as string;
		expect(replaced).toContain("FIRST match: src/a.ts:1");
		expect(replaced).toContain("LAST match: src/z.ts:9999");
		expect(replaced).toContain("tokens elided");
		expect(replaced).not.toContain("src/file2000.ts"); // middle elided
		expect(replaced.length).toBeLessThan(bigText.length);
	});
});

// ============================================================================
// compact() must not mutate live message objects when pruning (clone-before-prune)
// ============================================================================

describe("compact() prune isolation", () => {
	// These tests exercise the LLM summarization path (clone/abort isolation around
	// the summarizer call). Their windows carry almost no prose, so the default
	// structural-only fast path would skip the summarizer entirely — force the
	// always-LLM path here so the isolation assertions still run.
	beforeEach(() => {
		process.env.PIT_NO_STRUCTURAL_COMPACTION = "1";
	});
	afterEach(() => {
		delete process.env.PIT_NO_STRUCTURAL_COMPACTION;
	});

	function makeToolResult(text: string): AgentMessage {
		return {
			role: "toolResult" as const,
			content: [{ type: "text" as const, text }],
			toolCallId: "tc-live",
			toolName: "read",
			isError: false,
			timestamp: Date.now(),
		} as any;
	}

	// Fake streamFn: returns a canned summary without any network call. compact() →
	// completeSummarization only calls `.result()`, so this minimal shape suffices.
	function fakeStreamFn(summaryText: string) {
		const response: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: summaryText }],
			usage: createMockUsage(10, 10),
			stopReason: "stop",
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		};
		return (() => ({ result: async () => response })) as any;
	}

	it("prunes a clone, leaving the original live toolResult message unmutated on success", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const bigText = "x".repeat(90_000); // ~27k dense tokens, well over the prune threshold

		// toolResult sits BEFORE two user turns so it is outside the protection window.
		const liveToolResult = makeToolResult(bigText);
		const liveBlock = (liveToolResult as any).content[0];
		const messagesToSummarize: AgentMessage[] = [
			liveToolResult,
			createUserMessage("q1"),
			createAssistantMessage("a1"),
			createUserMessage("q2"),
			createAssistantMessage("a2"),
		];

		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-id",
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, selfCorrection: false },
		};

		const result = await compact(
			preparation,
			model,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			fakeStreamFn("## Goal\nfake summary"),
		);

		// Happy path produced a summary.
		expect(result.summary).toContain("fake summary");
		// The ORIGINAL live message object is untouched — prune hit a clone, so an
		// aborted compaction would leave the live context intact.
		expect(liveBlock.text).toBe(bigText);
		expect(liveBlock.text.length).toBe(90_000);
		// The array still holds the same object identity (not swapped out).
		expect(messagesToSummarize[0]).toBe(liveToolResult);
	});

	it("leaves the live toolResult unmutated even when summarization aborts after pruning", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const bigText = "z".repeat(90_000);

		const liveToolResult = makeToolResult(bigText);
		const liveBlock = (liveToolResult as any).content[0];
		const messagesToSummarize: AgentMessage[] = [
			liveToolResult,
			createUserMessage("q1"),
			createAssistantMessage("a1"),
			createUserMessage("q2"),
			createAssistantMessage("a2"),
		];

		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept-id",
			messagesToSummarize,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 50_000,
			fileOps: createFileOps(),
			settings: { ...DEFAULT_COMPACTION_SETTINGS, selfCorrection: false },
		};

		// streamFn that throws → compact() rejects (simulates an aborted/failed summary).
		const throwingStreamFn = (() => {
			throw new Error("aborted");
		}) as any;

		await expect(
			compact(preparation, model, undefined, undefined, undefined, undefined, undefined, throwingStreamFn),
		).rejects.toThrow();

		// Even though pruning ran before the failed LLM call, the live object is intact.
		expect(liveBlock.text).toBe(bigText);
		expect(liveBlock.text.length).toBe(90_000);
	});
});

// ============================================================================
// pruneOldToolOutputs — mutation tool-call argument bodies (write/edit)
// ============================================================================

describe("pruneOldToolOutputs — mutation tool-call args", () => {
	afterEach(() => {
		delete process.env.PIT_DEFER_HISTORY;
	});

	function bigWriteCall(): AgentMessage {
		return {
			role: "assistant" as const,
			content: [
				{
					type: "toolCall" as const,
					id: "tc-w",
					name: "write",
					arguments: { path: "big.ts", content: "Z".repeat(90_000) },
				},
			],
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
		} as any;
	}

	const userMsg = (): AgentMessage => ({ role: "user" as const, content: "q", timestamp: Date.now() });
	const recentText = (): AgentMessage =>
		({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done" }],
			timestamp: Date.now(),
		}) as any;

	it("elides an old write's content body but keeps the path, and leaves recent ones intact", () => {
		delete process.env.PIT_DEFER_HISTORY;
		const oldWrite = bigWriteCall();
		const recentWrite = bigWriteCall();
		// oldWrite at index 0 (prunable); recentWrite at index 2 (within protected turns).
		const messages: AgentMessage[] = [oldWrite, userMsg(), recentWrite, userMsg(), recentText()];

		const reclaimed = pruneOldToolOutputs(messages);

		const oldArgs = (messages[0] as any).content[0].arguments as { path: string; content: string };
		expect(oldArgs.path).toBe("big.ts");
		expect(oldArgs.content).toContain("chars elided");
		expect(oldArgs.content.length).toBeLessThan(200);
		expect(reclaimed).toBeGreaterThan(0);

		// The recent write (protected) is untouched.
		const recentArgs = (messages[2] as any).content[0].arguments as { content: string };
		expect(recentArgs.content.length).toBe(90_000);
	});

	it("clones the assistant tool-call layer so an aborted prune never mutates the live context", () => {
		delete process.env.PIT_DEFER_HISTORY;
		const live: AgentMessage[] = [bigWriteCall(), userMsg(), recentText(), userMsg(), recentText()];

		const clone = cloneToolResultMessagesForPrune(live);
		pruneOldToolOutputs(clone);

		expect(((clone[0] as any).content[0].arguments.content as string).length).toBeLessThan(200);
		// Live context's arguments object is left intact.
		expect(((live[0] as any).content[0].arguments.content as string).length).toBe(90_000);
	});
});
