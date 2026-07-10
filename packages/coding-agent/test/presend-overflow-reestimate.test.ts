// Regression for #14: the pre-send overflow guard must RE-ESTIMATE the assembled
// context after awaiting an in-flight background compaction. Otherwise it fires a
// redundant full compaction based on the stale (pre-compaction) estimate.

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

// Marker-driven estimate: tokens come from the last message carrying `__assembled`.
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
		// Only the pre-send overflow guard matters here; keep the threshold path inert.
		shouldCompact: () => false,
		computeDynamicReserve: (_w: number, r: number) => r,
		proactivePruneFloor: (contextWindow: number, override?: number) =>
			override !== undefined && override > 0 ? override : Math.max(64_000, Math.floor((contextWindow || 0) * 0.25)),
		shouldCompactSoft: () => false,
	};
});

describe("pre-send overflow guard re-estimates after background compaction (#14)", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-presend-reestimate-${Date.now()}`);
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

	it("does not run a redundant compaction when the background one already reduced context", async () => {
		const model = session.model!;
		const window = model.contextWindow ?? 200_000;
		const high = window; // > window * 0.95 => guard would trip
		const low = Math.floor(window * 0.1); // after background compaction

		// agent.state.messages carries the assembled marker (initially high).
		const stateMsg = {
			role: "assistant",
			content: [{ type: "text", text: "x" }],
			__assembled: high,
		} as unknown as AssistantMessage;
		session.agent.state.messages = [stateMsg];

		// Simulate an in-flight predictive background compaction; awaiting it reduces
		// the assembled context (flip the marker low).
		session.compaction.backgroundCompactionPromise = Promise.resolve().then(() => {
			(stateMsg as unknown as { __assembled: number }).__assembled = low;
		});

		const compactionStarts: string[] = [];
		session.subscribe((event) => {
			if (event.type === "compaction_start") compactionStarts.push(event.reason);
		});

		// The assistant message that triggers the check: usage well below threshold,
		// so contextTokens < assembled (the guard's `assembled > contextTokens`).
		const trigger: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: Math.floor(window * 0.4),
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: Math.floor(window * 0.4),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		await compactionModule.checkCompaction(session.compaction, trigger, true, false);

		// Re-estimate dropped below threshold => no redundant compaction.
		expect(compactionStarts).toHaveLength(0);
	});
});
