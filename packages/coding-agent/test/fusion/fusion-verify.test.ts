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

const { spawnSubagent, exceptionalUsage } = vi.hoisted(() => ({
	spawnSubagent: vi.fn(),
	exceptionalUsage: new WeakMap<
		object,
		{ inputTokens: number; outputTokens: number; totalTokens: number; costUsd: number }
	>(),
}));

vi.mock("../../src/core/coordinator/spawn.ts", () => ({
	spawnSubagent: (...args: unknown[]) => spawnSubagent(...args),
	getSubagentErrorUsage: (error: unknown) =>
		typeof error === "object" && error !== null ? exceptionalUsage.get(error) : undefined,
}));

vi.mock("../../src/core/coordinator/index.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/core/coordinator/index.ts")>();
	return {
		...actual,
		spawnSubagent: (...args: unknown[]) => spawnSubagent(...args),
	};
});

const model = getModel("anthropic", "claude-sonnet-5")!;

const emptyAnalysis: JudgeAnalysis = {
	consensus: [],
	contradictions: [],
	partialCoverage: [],
	uniqueInsights: [],
	blindSpots: [],
	unsupportedClaims: [],
};

function createHost(): {
	host: FusionHost;
	events: AgentSessionEvent[];
	fusionSpend: ReturnType<typeof vi.fn>;
} {
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
	const fusionSpend = vi.fn();
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
		recordFusionSpend: fusionSpend,
		prepareFusionContextEconomy: async () => {},
		evaluateFusionBudget: () => ({ allowed: true }),
	};
	return { host, events, fusionSpend };
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

	it("charges verifier usage before failing open on spawn failure", async () => {
		const error = new Error("spawn failed");
		exceptionalUsage.set(error, { inputTokens: 20, outputTokens: 7, totalTokens: 31, costUsd: 0.01 });
		spawnSubagent.mockRejectedValue(error);
		const { host, fusionSpend } = createHost();
		const result = await fusionVerify(host, "Q", [], emptyAnalysis, model);
		expect(result).toBeUndefined();
		expect(fusionSpend).toHaveBeenCalledOnce();
		expect(fusionSpend).toHaveBeenCalledWith(31);
	});
});
