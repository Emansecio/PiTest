import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { aggregateAssistantUsage, consumedTokens, mergeSubagentUsage } from "../src/core/token-usage.ts";
import { createTestResourceLoader } from "./utilities.ts";

const model = getModel("anthropic", "claude-sonnet-5")!;

function usage(overrides: Record<string, unknown> = {}) {
	return {
		input: 3,
		output: 4,
		cacheRead: 5,
		cacheWrite: 6,
		totalTokens: 999,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 },
		...overrides,
	};
}

describe("token usage helpers", () => {
	it("computes consumed tokens from all four components instead of native totalTokens", () => {
		expect(consumedTokens(usage())).toBe(18);
	});

	it("treats non-finite and negative token components as zero", () => {
		expect(
			consumedTokens(usage({ input: -1, output: Number.NaN, cacheRead: Number.POSITIVE_INFINITY, cacheWrite: 7 })),
		).toBe(7);
	});

	it("saturates consumed tokens at Number.MAX_SAFE_INTEGER", () => {
		expect(
			consumedTokens({
				input: Number.MAX_SAFE_INTEGER - 1,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1,
			}),
		).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("aggregates assistant usage inclusively while preserving cost", () => {
		const aggregate = aggregateAssistantUsage([
			{ role: "user", content: "ignored" },
			{ role: "assistant", usage: usage() },
			{
				role: "assistant",
				usage: usage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } }),
			},
		]);

		expect(aggregate).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 28, costUsd: 0.75 });
	});

	it("saturates aggregate assistant token fields while retaining floating cost arithmetic", () => {
		const aggregate = aggregateAssistantUsage([
			{
				role: "assistant",
				usage: usage({
					input: Number.MAX_SAFE_INTEGER - 1,
					output: Number.MAX_SAFE_INTEGER - 2,
					cacheRead: 0,
					cacheWrite: 0,
				}),
			},
			{
				role: "assistant",
				usage: usage({ input: 10, output: 20, cacheRead: 1, cacheWrite: 1, cost: { total: 0.5 } }),
			},
		]);

		expect(aggregate).toEqual({
			inputTokens: Number.MAX_SAFE_INTEGER,
			outputTokens: Number.MAX_SAFE_INTEGER,
			totalTokens: Number.MAX_SAFE_INTEGER,
			costUsd: 0.75,
		});
	});

	it("merges subagent usage without mutating inputs", () => {
		const first = { inputTokens: 1, outputTokens: 2, totalTokens: 8, costUsd: 0.1 };
		const second = { inputTokens: 3, outputTokens: 4, totalTokens: 12, costUsd: 0.2 };
		const merged = mergeSubagentUsage(first, undefined, second);

		expect(merged).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 20, costUsd: 0.30000000000000004 });
		expect(first).toEqual({ inputTokens: 1, outputTokens: 2, totalTokens: 8, costUsd: 0.1 });
	});

	it("saturates merged token fields while retaining floating cost arithmetic", () => {
		const merged = mergeSubagentUsage(
			{
				inputTokens: Number.MAX_SAFE_INTEGER - 1,
				outputTokens: Number.MAX_SAFE_INTEGER - 2,
				totalTokens: Number.MAX_SAFE_INTEGER - 3,
				costUsd: 0.1,
			},
			{ inputTokens: 10, outputTokens: 20, totalTokens: 30, costUsd: 0.2 },
		);

		expect(merged).toMatchObject({
			inputTokens: Number.MAX_SAFE_INTEGER,
			outputTokens: Number.MAX_SAFE_INTEGER,
			totalTokens: Number.MAX_SAFE_INTEGER,
		});
		expect(merged.costUsd).toBeCloseTo(0.3);
	});
});

describe("main Goal token accounting", () => {
	it("charges cache reads and writes for a completed main turn", async () => {
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "sys", tools: [], thinkingLevel: "off" },
			}),
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			cwd: process.cwd(),
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			session.startGoal("account for cached tokens", { tokenBudget: 1000 });
			(session as unknown as { _recordGoalTurn(message: unknown): void })._recordGoalTurn({
				usage: usage(),
				stopReason: "stop",
			});

			expect(session.getTokenBudgetSnapshot().mainTokens).toBe(18);
		} finally {
			await session.dispose();
		}
	});
});
