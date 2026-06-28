import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@pit/agent-core";
import { Agent } from "@pit/agent-core";
import { type AssistantMessage, getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import * as compactionModule from "../src/core/agent-session-compaction.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { WireEstimateInput, WireUsageEstimate } from "../src/core/compaction/compaction.js";
import * as compactionCore from "../src/core/compaction/compaction.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: { totalTokens?: number; input?: number }) => usage.totalTokens ?? usage.input ?? 0,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} }),
	estimateContextTokens: () => ({
		tokens: 1000,
		usageTokens: 1000,
		trailingTokens: 0,
		lastUsageIndex: 0,
	}),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ dummy: true }),
	shouldCompact: () => false,
	computeDynamicReserve: (_contextWindow: number, configuredReserve: number) => configuredReserve,
	proactivePruneFloor: (contextWindow: number, override?: number) =>
		override !== undefined && override > 0 ? override : Math.max(64_000, Math.floor((contextWindow || 0) * 0.25)),
	shouldCompactSoft: () => false,
}));

describe("checkPresendOverflow wire estimate", () => {
	let session: AgentSession;
	let tempDir: string;
	let estimateWireSpy: MockInstance<(messages: AgentMessage[], input: WireEstimateInput) => WireUsageEstimate>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-presend-wire-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

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

		estimateWireSpy = vi.spyOn(compactionCore, "estimateWireTokens");
	});

	afterEach(async () => {
		estimateWireSpy.mockRestore();
		await session.dispose();
		vi.restoreAllMocks();
		delete process.env.PIT_NO_PRESEND_OVERFLOW_GUARD;
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	function freshAssistant(totalTokens: number): AssistantMessage {
		const model = session.model!;
		return {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: totalTokens,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	function compactionStarts(): string[] {
		const starts: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") starts.push(event.reason);
		});
		return starts;
	}

	it("forces compaction when pending user pushes wire estimate over the guard ratio", async () => {
		const window = session.model!.contextWindow ?? 200_000;
		estimateWireSpy.mockReturnValue({
			tokens: Math.floor(window * 0.97),
			messageTokens: 1000,
			usageTokens: 1000,
			trailingTokens: 0,
			lastUsageIndex: 0,
			systemTokens: 5000,
			toolTokens: 10000,
			pendingTokens: 8000,
		});

		const pending: AgentMessage[] = [
			{
				role: "user",
				content: [{ type: "text", text: "large pending prompt" }],
				timestamp: Date.now(),
			} as AgentMessage,
		];
		const starts = compactionStarts();
		await compactionModule.checkPresendOverflow(session.compaction, freshAssistant(1000), {
			systemPrompt: "x".repeat(20_000),
			tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
			pendingMessages: pending,
		});
		expect(starts).toEqual(["threshold"]);
		expect(estimateWireSpy).toHaveBeenCalled();
		const wireInput = estimateWireSpy.mock.calls[0]?.[1];
		expect(wireInput?.pendingMessages).toBe(pending);
	});

	it("does not fire when wire estimate is under the guard ratio", async () => {
		const window = session.model!.contextWindow ?? 200_000;
		estimateWireSpy.mockReturnValue({
			tokens: Math.floor(window * 0.5),
			messageTokens: 1000,
			usageTokens: 1000,
			trailingTokens: 0,
			lastUsageIndex: 0,
			systemTokens: 2000,
			toolTokens: 3000,
			pendingTokens: 500,
		});

		const starts = compactionStarts();
		await compactionModule.checkPresendOverflow(session.compaction, freshAssistant(1000), {
			systemPrompt: "short",
			tools: [],
			pendingMessages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } as AgentMessage],
		});
		expect(starts).toHaveLength(0);
	});
});
