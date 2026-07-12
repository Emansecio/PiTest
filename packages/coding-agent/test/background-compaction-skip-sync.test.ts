// P01: after predictive background compaction reduces context, the hard
// shouldCompact path must not fire a redundant sync compact based on stale
// lastAssistant.usage (promise already cleared by the time the next prompt runs).

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@pit/agent-core";
import { type AssistantMessage, getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import * as compactionModule from "../src/core/agent-session-compaction.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

vi.mock("../src/core/compaction/index.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/compaction/index.js")>();
	return {
		...actual,
		calculateContextTokens: (usage: { totalTokens?: number }) => usage.totalTokens ?? 0,
		adaptiveKeepRecentTokens: () => undefined,
		collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
		sumMessageTokens: () => 0,
		compact: async () => ({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} }),
		estimateContextTokens: (messages: Array<{ __assembled?: number }>) => {
			for (let i = messages.length - 1; i >= 0; i--) {
				const a = messages[i]?.__assembled;
				if (typeof a === "number") return { tokens: a, usageTokens: a, trailingTokens: 0, lastUsageIndex: i };
			}
			return { tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null };
		},
		estimateWireTokens: (messages: Array<{ __assembled?: number }>) => {
			for (let i = messages.length - 1; i >= 0; i--) {
				const a = messages[i]?.__assembled;
				if (typeof a === "number") {
					return {
						tokens: a,
						usageTokens: a,
						trailingTokens: 0,
						lastUsageIndex: i,
						messageTokens: a,
						systemTokens: 0,
						toolTokens: 0,
						pendingTokens: 0,
					};
				}
			}
			return {
				tokens: 0,
				usageTokens: 0,
				trailingTokens: 0,
				lastUsageIndex: null,
				messageTokens: 0,
				systemTokens: 0,
				toolTokens: 0,
				pendingTokens: 0,
			};
		},
		generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
		prepareCompaction: () => ({ dummy: true }),
		// Real-ish hard threshold: compact when tokens exceed 50% of a 200k window.
		shouldCompact: (tokens: number, contextWindow: number) => tokens > contextWindow * 0.5,
		computeDynamicReserve: (_w: number, r: number) => r,
		proactivePruneFloor: (contextWindow: number, override?: number) =>
			override !== undefined && override > 0 ? override : Math.max(64_000, Math.floor((contextWindow || 0) * 0.25)),
		shouldCompactSoft: () => false,
	};
});

describe("P01 skip sync compact after background already reduced context", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-p01-skip-sync-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
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
				/* ignore */
			}
		}
	});

	it("skips hard sync compact when live estimate is below threshold after background", async () => {
		const model = session.model!;
		const window = model.contextWindow ?? 200_000;
		const low = Math.floor(window * 0.1);

		// Background already finished: messages reflect post-compact size, promise cleared.
		const stateMsg = {
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			__assembled: low,
		} as unknown as AssistantMessage;
		session.agent.state.messages = [stateMsg];
		expect(session.compaction.backgroundCompactionPromise).toBeUndefined();

		const compactionStarts: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") compactionStarts.push(event.reason);
		});

		// Stale usage from the pre-background turn still looks "over threshold".
		const trigger: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: Math.floor(window * 0.9),
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: Math.floor(window * 0.9),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const didCompact = await compactionModule.checkCompaction(session.compaction, trigger, true, false, {
			skipPresendGuard: true,
		});

		expect(didCompact).toBe(false);
		expect(compactionStarts).toHaveLength(0);
	});

	it("still sync-compacts when live estimate remains over threshold", async () => {
		const model = session.model!;
		const window = model.contextWindow ?? 200_000;
		const stillHigh = Math.floor(window * 0.9);

		const stateMsg = {
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			__assembled: stillHigh,
		} as unknown as AssistantMessage;
		session.agent.state.messages = [stateMsg];

		const compactionStarts: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") compactionStarts.push(event.reason);
		});

		const trigger: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: stillHigh,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: stillHigh,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		const didCompact = await compactionModule.checkCompaction(session.compaction, trigger, true, false, {
			skipPresendGuard: true,
		});

		// P01 only requires we still enter the sync path when live estimate is high.
		// prepareCompaction may no-op on an empty in-memory branch (returns false).
		expect(compactionStarts).toEqual(["threshold"]);
		void didCompact;
	});
});
