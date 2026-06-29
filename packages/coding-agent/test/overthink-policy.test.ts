import type { Model } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { resolveOverthinkGuardForModel } from "../src/core/overthink-policy.js";
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
	it("uses a lower threshold for weak/open providers", () => {
		const guard = resolveOverthinkGuardForModel(createModel("opencode"), "medium", baseSettings);
		expect(guard.enabled).toBe(true);
		expect(guard.tokenThreshold).toBe(1000);
		expect(guard.watchTextDelta).toBe(true);
	});

	it("uses a higher threshold for native frontier providers", () => {
		const guard = resolveOverthinkGuardForModel(createModel("anthropic"), "high", baseSettings);
		expect(guard.enabled).toBe(true);
		expect(guard.tokenThreshold).toBe(2500);
		expect(guard.watchTextDelta).toBe(false);
	});

	it("honours an explicit tokenThreshold override", () => {
		const guard = resolveOverthinkGuardForModel(createModel("anthropic"), "high", {
			...baseSettings,
			tokenThreshold: 500,
		});
		expect(guard.tokenThreshold).toBe(500);
	});

	it("disables when settings.enabled is false", () => {
		const guard = resolveOverthinkGuardForModel(createModel("opencode"), "medium", {
			...baseSettings,
			enabled: false,
		});
		expect(guard.enabled).toBe(false);
	});

	it("disables frontier models with thinking off and no reasoning metadata", () => {
		const guard = resolveOverthinkGuardForModel(createModel("openai", false), "off", baseSettings);
		expect(guard.enabled).toBe(false);
	});
});
