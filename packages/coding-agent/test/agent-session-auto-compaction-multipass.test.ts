import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import * as compactionModule from "../src/core/agent-session-compaction.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const mockState = vi.hoisted(() => ({
	// Stale usage-based estimate (pre-compaction figure carried by kept messages).
	contextTokens: 0,
	// Pure per-message estimate of the post-compaction context (sumMessageTokens).
	postTokens: 0,
	// Whether prepareCompaction finds a summarizable span for the second pass.
	hasSpan: true,
}));

vi.mock("../src/core/compaction/index.js", () => ({
	adaptiveKeepRecentTokens: () => undefined,
	calculateContextTokens: (usage: { totalTokens?: number }) => usage.totalTokens ?? 0,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} }),
	computeDynamicReserve: (_contextWindow: number, configuredReserve: number) => configuredReserve,
	estimateContextTokens: () => ({
		tokens: mockState.contextTokens,
		usageTokens: mockState.contextTokens,
		trailingTokens: 0,
		lastUsageIndex: 0,
	}),
	// Boot path (T02) calls getContextUsage → estimateWireTokens during prompt rebuild.
	estimateWireTokens: () => ({
		tokens: mockState.contextTokens,
		usageTokens: mockState.contextTokens,
		trailingTokens: 0,
		lastUsageIndex: 0,
	}),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({
		firstKeptEntryId: "entry-1",
		messagesToSummarize: mockState.hasSpan ? [{ role: "user", content: "old", timestamp: 1 }] : [],
		turnPrefixMessages: [],
	}),
	proactivePruneFloor: (contextWindow: number, override?: number) =>
		override !== undefined && override > 0 ? override : Math.max(64_000, Math.floor((contextWindow || 0) * 0.25)),
	// T08: second pass uses hard shouldCompact only (via shouldRunCompactionSecondPass).
	shouldCompact: (contextTokens: number, contextWindow: number, settings: { reserveTokens: number }) => {
		const reserve = settings?.reserveTokens ?? 16_384;
		const window = contextWindow || 200_000;
		return contextTokens > window - reserve;
	},
	shouldCompactSoft: (contextTokens: number) => contextTokens > 0,
	sumMessageTokens: () => mockState.postTokens,
}));

describe("AgentSession auto-compaction multipass", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auto-compaction-multipass-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		mockState.contextTokens = 100_000;
		mockState.postTokens = 0;
		mockState.hasSpan = true;

		const model = getModel("anthropic", "claude-sonnet-5")!;
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });
		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
	});

	afterEach(async () => {
		await session.dispose();
		vi.restoreAllMocks();
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	async function collectCompactionEvents(): Promise<Array<{ type: string; reason: string }>> {
		const events: Array<{ type: string; reason: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start" || event.type === "compaction_end") {
				events.push({ type: event.type, reason: event.reason });
			}
		});
		await compactionModule.runAutoCompaction(session.compaction, "threshold", false);
		return events;
	}

	it("runs one extra threshold compaction when REAL residual pressure remains and there is a summarizable span", async () => {
		// Pure post-compaction estimate still above the HARD threshold → legitimate fallback.
		// Sonnet contextWindow is 200k; reserve 16_384 → hard at ~183_616.
		mockState.postTokens = 190_000;
		const events = await collectCompactionEvents();

		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(2);
	});

	it("does NOT run a second pass when only soft residual pressure remains (T08)", async () => {
		// Soft band used to re-fire; hard-only second pass must skip this.
		mockState.postTokens = 100_000;
		const events = await collectCompactionEvents();

		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
	});

	it("does NOT re-fire on the stale usage-based estimate when the pure estimate shows the pass worked", async () => {
		// The kept assistant messages still carry pre-compaction usage (100k), but
		// the pure per-message sum shows the context actually shrank. The old
		// re-check trusted the stale figure and ran a second pipeline on nearly
		// every threshold compaction.
		mockState.contextTokens = 100_000;
		mockState.postTokens = 0;
		const events = await collectCompactionEvents();

		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
	});

	it("skips the second pass when there is nothing left to summarize (progress guard)", async () => {
		// Residual HARD pressure, but the previous pass already kept only the retention
		// window — a second pipeline would be a paid no-op.
		mockState.postTokens = 190_000;
		mockState.hasSpan = false;
		const events = await collectCompactionEvents();

		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(1);
		expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
	});
});
