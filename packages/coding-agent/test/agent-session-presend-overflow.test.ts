import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@pit/agent-core";
import { type AssistantMessage, getModel } from "@pit/ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

// Controls what estimateContextTokens reports for the assembled payload (usage +
// trailing tool results). The pre-send overflow guard keys off this value.
const mockState = vi.hoisted(() => ({ assembledTokens: 0 }));

vi.mock("../src/core/compaction/index.js", () => ({
	calculateContextTokens: (usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens?: number;
	}) => usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
	collectEntriesForBranchSummary: () => ({ entries: [], commonAncestorId: null }),
	compact: async () => ({ summary: "compacted", firstKeptEntryId: "entry-1", tokensBefore: 100, details: {} }),
	// Assembled payload estimate (usage + trailing). Driven by mockState so each
	// test can simulate a large tool result landing after the last model response.
	estimateContextTokens: () => ({
		tokens: mockState.assembledTokens,
		usageTokens: mockState.assembledTokens,
		trailingTokens: 0,
		lastUsageIndex: 0,
	}),
	generateBranchSummary: async () => ({ summary: "", aborted: false, readFiles: [], modifiedFiles: [] }),
	prepareCompaction: () => ({ dummy: true }),
	// Force the normal threshold path to NEVER fire, so only the pre-send guard can
	// trigger _runAutoCompaction in these tests.
	shouldCompact: () => false,
	computeDynamicReserve: (_contextWindow: number, configuredReserve: number) => configuredReserve,
	proactivePruneFloor: (contextWindow: number, override?: number) =>
		override !== undefined && override > 0 ? override : Math.max(64_000, Math.floor((contextWindow || 0) * 0.25)),
	shouldCompactSoft: () => false,
}));

describe("AgentSession pre-send overflow guard", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-presend-overflow-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });

		sessionManager = SessionManager.inMemory();
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

	function spyAutoCompaction() {
		return vi
			.spyOn(
				session as unknown as {
					_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<void>;
				},
				"_runAutoCompaction",
			)
			.mockResolvedValue();
	}

	function checkCompaction(msg: AssistantMessage): Promise<void> {
		return (
			session as unknown as {
				_checkCompaction: (m: AssistantMessage, skipAbortedCheck?: boolean) => Promise<void>;
			}
		)._checkCompaction.bind(session)(msg);
	}

	it("forces compaction when the assembled payload nears the window ceiling", async () => {
		const window = session.model!.contextWindow ?? 200_000;
		mockState.assembledTokens = Math.floor(window * 0.97); // above the 0.95 guard ratio
		const spy = spyAutoCompaction();
		// usage of the last response is small — the normal threshold path (mocked off)
		// wouldn't fire; only the trailing-aware guard catches the imminent overflow.
		await checkCompaction(freshAssistant(1000));
		expect(spy).toHaveBeenCalledWith("threshold", false);
	});

	it("does not fire when the assembled payload is well under the ceiling", async () => {
		const window = session.model!.contextWindow ?? 200_000;
		mockState.assembledTokens = Math.floor(window * 0.5);
		const spy = spyAutoCompaction();
		await checkCompaction(freshAssistant(1000));
		expect(spy).not.toHaveBeenCalled();
	});

	it("respects the PIT_NO_PRESEND_OVERFLOW_GUARD kill-switch", async () => {
		process.env.PIT_NO_PRESEND_OVERFLOW_GUARD = "1";
		const window = session.model!.contextWindow ?? 200_000;
		mockState.assembledTokens = Math.floor(window * 0.97);
		const spy = spyAutoCompaction();
		await checkCompaction(freshAssistant(1000));
		expect(spy).not.toHaveBeenCalled();
	});
});
