/**
 * Unit coverage for fusionVerify (verify subagent spawn + fail-open).
 */

import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CompactionController } from "../../src/core/agent-session-compaction.ts";
import type { AgentSessionEvent } from "../../src/core/agent-session-events.ts";
import { type FusionHost, fusionVerify } from "../../src/core/agent-session-fusion.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { JudgeAnalysis } from "../../src/core/fusion/types.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const spawnSubagent = vi.hoisted(() => vi.fn());

vi.mock("../../src/core/coordinator/spawn.ts", () => ({
	spawnSubagent: (...args: unknown[]) => spawnSubagent(...args),
}));

vi.mock("../../src/core/coordinator/index.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/coordinator/index.ts")>();
	return {
		...actual,
		spawnSubagent: (...args: unknown[]) => spawnSubagent(...args),
	};
});

const model = getModel("anthropic", "claude-sonnet-4-5")!;

const emptyAnalysis: JudgeAnalysis = {
	consensus: [],
	contradictions: [],
	partialCoverage: [],
	uniqueInsights: [],
	blindSpots: [],
	unsupportedClaims: [],
};

function createHost(): { host: FusionHost; events: AgentSessionEvent[] } {
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const settingsManager = SettingsManager.inMemory({
		fusion: {
			panel: [
				{ cli: "claude", model: "opus" },
				{ cli: "codex", model: "gpt" },
			],
			verify: true,
			verifyTimeoutMs: 5_000,
			brief: false,
			staggerSameCliMs: 0,
		},
	});
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "sys",
			tools: [],
			thinkingLevel: "off",
		},
	});
	const sessionManager = SessionManager.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const events: AgentSessionEvent[] = [];
	let fusionAbort: AbortController | undefined;
	const host: FusionHost = {
		model,
		agent,
		sessionManager,
		settingsManager,
		modelRegistry,
		cwd: process.cwd(),
		compaction: new CompactionController({
			sessionId: "test",
			model,
			thinkingLevel: "off",
			agent,
			sessionManager,
			settingsManager,
			extensionRunner: { emit: async () => {}, hasHandlers: () => false } as never,
			modelRegistry,
			hindsightBank: undefined,
			readDedupeStore: undefined,
			cwd: process.cwd(),
			isCompacting: false,
			isStreaming: false,
			emit: () => {},
			getCompactionRequestAuth: async () => ({}),
			disconnectFromAgent: () => {},
			reconnectToAgent: () => {},
			abort: async () => {},
		}),
		get fusionAbort() {
			return fusionAbort;
		},
		setFusionAbort(value) {
			fusionAbort = value;
		},
		userInterrupted: false,
		emit(event: AgentSessionEvent) {
			events.push(event);
		},
		getRequiredRequestAuth: async () => ({}),
		setLastAssistantMessage: () => {},
		prepareFusionContextEconomy: async () => {},
		evaluateFusionBudget: () => ({ allowed: true }),
	};
	return { host, events };
}

describe("fusionVerify", () => {
	beforeEach(() => {
		spawnSubagent.mockReset();
	});

	it("emits fusion_stage verify and returns the verification report", async () => {
		const report = {
			findings: [{ claim: "x", verdict: "confirmed" as const, evidence: "ok" }],
		};
		spawnSubagent.mockResolvedValue({
			value: report,
			usage: { totalTokens: 10 },
		});
		const { host, events } = createHost();
		const result = await fusionVerify(host, "Q", [], emptyAnalysis, model);
		expect(result).toEqual(report);
		expect(events.some((e) => e.type === "fusion_stage" && (e as { stage?: string }).stage === "verify")).toBe(true);
		expect(spawnSubagent).toHaveBeenCalledOnce();
	});

	it("returns undefined on spawn failure (fail-open)", async () => {
		spawnSubagent.mockRejectedValue(new Error("spawn failed"));
		const { host } = createHost();
		const result = await fusionVerify(host, "Q", [], emptyAnalysis, model);
		expect(result).toBeUndefined();
	});
});
