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

const mockState = vi.hoisted(() => ({ contextTokens: 0 }));

vi.mock("../src/core/compaction/index.js", () => ({
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
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ firstKeptEntryId: "entry-1" }),
	proactivePruneFloor: (contextWindow: number, override?: number) =>
		override !== undefined && override > 0 ? override : Math.max(64_000, Math.floor((contextWindow || 0) * 0.25)),
	shouldCompact: () => false,
	shouldCompactSoft: (contextTokens: number) => contextTokens > 0,
}));

describe("AgentSession auto-compaction multipass", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-auto-compaction-multipass-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		mockState.contextTokens = 100_000;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
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

	it("runs one extra threshold compaction when the first pass still leaves soft pressure", async () => {
		const events: Array<{ type: string; reason: string }> = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start" || event.type === "compaction_end") {
				events.push({ type: event.type, reason: event.reason });
			}
		});

		await compactionModule.runAutoCompaction(session.compaction, "threshold", false);

		expect(events.filter((event) => event.type === "compaction_start")).toHaveLength(2);
		expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(2);
	});
});
