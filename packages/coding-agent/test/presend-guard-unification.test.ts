// Bug 2 (residual) — the two presend guards must measure in the SAME space.
// checkPresendOverflow always used the full wire estimate (messages + system
// prompt + tool schemas); the internal guard in checkCompaction used a
// messages-only estimate against the same ratio, so the two never agreed at
// the boundary and lastCompactionDeficit mixed units. checkPresendOverflow now
// captures the wire prefix surface on the controller and checkCompaction's
// guard reuses it (falling back to messages-only before the first presend).

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
	adaptiveKeepRecentTokens: () => undefined,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	sumMessageTokens: () => 0,
	compact: async () => ({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} }),
	// Messages-only estimate: deliberately LOW so any guard trip observed in the
	// tests can only come from the (mocked-high) wire estimate.
	estimateContextTokens: () => ({
		tokens: 1000,
		usageTokens: 1000,
		trailingTokens: 0,
		lastUsageIndex: 0,
	}),
	estimateWireTokens: () => ({
		tokens: 1000,
		usageTokens: 1000,
		trailingTokens: 0,
		lastUsageIndex: 0,
		messageTokens: 1000,
		systemTokens: 0,
		toolTokens: 0,
		pendingTokens: 0,
	}),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ dummy: true }),
	shouldCompact: () => false,
	computeDynamicReserve: (_contextWindow: number, configuredReserve: number) => configuredReserve,
	proactivePruneFloor: (contextWindow: number, override?: number) =>
		override !== undefined && override > 0 ? override : Math.max(64_000, Math.floor((contextWindow || 0) * 0.25)),
	shouldCompactSoft: () => false,
}));

describe("presend guard space unification", () => {
	let session: AgentSession;
	let tempDir: string;
	let estimateWireSpy: MockInstance<(messages: AgentMessage[], input: WireEstimateInput) => WireUsageEstimate>;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-guard-unification-${Date.now()}`);
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
		if (tempDir && existsSync(tempDir)) {
			try {
				rmSync(tempDir, { recursive: true });
			} catch {
				/* ignore Windows handle race */
			}
		}
	});

	function wireEstimate(tokens: number): WireUsageEstimate {
		return {
			tokens,
			messageTokens: 1000,
			usageTokens: 1000,
			trailingTokens: 0,
			lastUsageIndex: 0,
			systemTokens: 5000,
			toolTokens: 10000,
			pendingTokens: 0,
		};
	}

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

	it("checkPresendOverflow captures the wire prefix surface on the controller", async () => {
		const window = session.model!.contextWindow ?? 200_000;
		estimateWireSpy.mockReturnValue(wireEstimate(Math.floor(window * 0.5)));
		expect(session.compaction.lastWireSurface).toBeUndefined();

		const systemPrompt = "S".repeat(30_000);
		await compactionModule.checkPresendOverflow(session.compaction, freshAssistant(1000), {
			systemPrompt,
			tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
			pendingMessages: [],
		});

		expect(session.compaction.lastWireSurface?.systemPrompt).toBe(systemPrompt);
		expect(session.compaction.lastWireSurface?.tools).toHaveLength(1);
		// M7: the wire estimate received the full text for density classification.
		const wireInput = estimateWireSpy.mock.calls[0]?.[1];
		expect(wireInput?.systemPromptText).toBe(systemPrompt);
	});

	it("checkCompaction's internal guard measures in WIRE space once a surface is known", async () => {
		const window = session.model!.contextWindow ?? 200_000;
		// Capture the surface with a low estimate (presend does not fire).
		estimateWireSpy.mockReturnValue(wireEstimate(Math.floor(window * 0.5)));
		await compactionModule.checkPresendOverflow(session.compaction, freshAssistant(1000), {
			systemPrompt: "S".repeat(30_000),
			tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
			pendingMessages: [],
		});
		expect(session.compaction.lastWireSurface).toBeDefined();

		// Post-response check: wire says 97% full while the messages-only mock says
		// 1000 tokens. The unified guard must trust the wire figure and compact.
		estimateWireSpy.mockReturnValue(wireEstimate(Math.floor(window * 0.97)));
		const starts = compactionStarts();
		const result = await compactionModule.checkCompaction(session.compaction, freshAssistant(1000), true, false);

		expect(starts).toEqual(["threshold"]);
		expect(result).toBe(false); // no queued messages
		// The internal guard passed the captured surface (with text) to the estimator.
		const lastInput = estimateWireSpy.mock.calls.at(-1)?.[1];
		expect(lastInput?.systemPromptText).toBe(session.compaction.lastWireSurface?.systemPrompt);
	});

	it("falls back to the messages-only estimate before any presend captured a surface", async () => {
		const window = session.model!.contextWindow ?? 200_000;
		estimateWireSpy.mockReturnValue(wireEstimate(Math.floor(window * 0.97)));
		const starts = compactionStarts();

		// No surface yet -> the internal guard uses the (low) messages-only mock and
		// must NOT fire, and must not consult the wire estimator at all.
		await compactionModule.checkCompaction(session.compaction, freshAssistant(1000), true, false);
		expect(starts).toHaveLength(0);
		expect(estimateWireSpy).not.toHaveBeenCalled();
	});
});
