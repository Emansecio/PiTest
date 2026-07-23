import type { Model } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { defaultOverthinkGuardSettings, resolveOverthinkGuardForModel } from "../src/core/overthink-policy.js";
import type { ResolvedOverthinkGuardSettings } from "../src/core/settings-manager.js";

function createModel(provider: string, reasoning = true): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider,
		baseUrl: "https://example.invalid",
		reasoning,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

const baseSettings: ResolvedOverthinkGuardSettings = {
	enabled: true,
	weakTokenThreshold: 1000,
	strongTokenThreshold: 2500,
	maxRetriesPerTurn: 2,
};

describe("resolveOverthinkGuardForModel", () => {
	it("is permanently disabled for every model and settings combination", () => {
		const providers = ["opencode", "anthropic", "openai-codex", "qwencloud", "openai"];
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;

		for (const provider of providers) {
			for (const level of levels) {
				const guard = resolveOverthinkGuardForModel(createModel(provider), level, baseSettings);
				expect(guard.enabled).toBe(false);
				expect(guard.tokenThreshold).toBe(0);
				expect(guard.maxRetriesPerTurn).toBe(0);
			}
		}
	});

	it("ignores settings.enabled true", () => {
		const guard = resolveOverthinkGuardForModel(createModel("opencode"), "xhigh", {
			...baseSettings,
			enabled: true,
			tokenThreshold: 50_000,
			maxRetriesPerTurn: 99,
		});
		expect(guard).toEqual({ enabled: false, tokenThreshold: 0, maxRetriesPerTurn: 0 });
	});

	it("ignores modelOverrides that would enable or raise thresholds", () => {
		const settings: ResolvedOverthinkGuardSettings = {
			...baseSettings,
			modelOverrides: {
				mock: { enabled: true, tokenThreshold: 10_000, maxRetriesPerTurn: 5 },
			},
		};
		const guard = resolveOverthinkGuardForModel(createModel("qwencloud"), "xhigh", settings);
		expect(guard.enabled).toBe(false);
	});

	it("ignores thinking-level scaling", () => {
		const high = resolveOverthinkGuardForModel(createModel("anthropic"), "xhigh", baseSettings);
		const low = resolveOverthinkGuardForModel(createModel("anthropic"), "minimal", baseSettings);
		expect(high).toEqual(low);
		expect(high.enabled).toBe(false);
	});
});

describe("defaultOverthinkGuardSettings", () => {
	it("defaults to disabled", () => {
		const defaults = defaultOverthinkGuardSettings();
		expect(defaults.enabled).toBe(false);
		expect(defaults.weakTokenThreshold).toBe(1000);
		expect(defaults.strongTokenThreshold).toBe(2500);
		expect(defaults.maxRetriesPerTurn).toBe(2);
	});
});
