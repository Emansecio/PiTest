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
		const guard = resolveOverthinkGuardForModel(createModel("anthropic"), "medium", baseSettings);
		expect(guard.enabled).toBe(true);
		expect(guard.tokenThreshold).toBe(2500);
		expect(guard.watchTextDelta).toBe(false);
	});

	it("honours an explicit tokenThreshold override, bypassing scaling entirely", () => {
		for (const level of ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const) {
			const guard = resolveOverthinkGuardForModel(createModel("anthropic"), level, {
				...baseSettings,
				tokenThreshold: 500,
			});
			expect(guard.tokenThreshold).toBe(500);
		}
	});

	it("disables when settings.enabled is false", () => {
		const guard = resolveOverthinkGuardForModel(createModel("opencode"), "medium", {
			...baseSettings,
			enabled: false,
		});
		expect(guard.enabled).toBe(false);
	});

	it("disables frontier models with thinking off and no reasoning metadata", () => {
		const guard = resolveOverthinkGuardForModel(createModel("openai-codex", false), "off", baseSettings);
		expect(guard.enabled).toBe(false);
	});

	it("treats an undefined thinking level as a 1x (medium-equivalent) scale", () => {
		const strong = resolveOverthinkGuardForModel(createModel("anthropic"), undefined, baseSettings);
		expect(strong.enabled).toBe(true);
		expect(strong.tokenThreshold).toBe(2500);

		const weak = resolveOverthinkGuardForModel(createModel("opencode"), undefined, baseSettings);
		expect(weak.enabled).toBe(true);
		expect(weak.tokenThreshold).toBe(1000);
	});

	describe("scales the threshold by thinking level when no explicit override is set", () => {
		const cases: Array<{ level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra"; scale: number }> = [
			{ level: "minimal", scale: 0.5 },
			{ level: "low", scale: 0.75 },
			{ level: "medium", scale: 1 },
			{ level: "high", scale: 1.5 },
			{ level: "xhigh", scale: 2 },
			{ level: "max", scale: 2 },
			{ level: "ultra", scale: 2 },
		];

		for (const { level, scale } of cases) {
			it(`${level} -> ${scale}x base for strong providers`, () => {
				// Use a non-reasoning model so the off+strong disable special-case
				// (which only triggers on "off") never interferes with other levels.
				const guard = resolveOverthinkGuardForModel(createModel("anthropic"), level, baseSettings);
				expect(guard.enabled).toBe(true);
				expect(guard.tokenThreshold).toBe(Math.round(baseSettings.strongTokenThreshold * scale));
			});

			it(`${level} -> ${scale}x base for weak providers`, () => {
				const guard = resolveOverthinkGuardForModel(createModel("opencode"), level, baseSettings);
				expect(guard.enabled).toBe(true);
				expect(guard.tokenThreshold).toBe(Math.round(baseSettings.weakTokenThreshold * scale));
			});
		}

		it("off -> 1x base for strong providers when reasoning metadata is present", () => {
			const guard = resolveOverthinkGuardForModel(createModel("anthropic", true), "off", baseSettings);
			expect(guard.enabled).toBe(true);
			expect(guard.tokenThreshold).toBe(baseSettings.strongTokenThreshold);
		});

		it("off -> 1x base for weak providers (disable special-case is strong-only)", () => {
			const guard = resolveOverthinkGuardForModel(createModel("opencode", false), "off", baseSettings);
			expect(guard.enabled).toBe(true);
			expect(guard.tokenThreshold).toBe(baseSettings.weakTokenThreshold);
		});
	});

	it("still disables off+strong+no-reasoning regardless of scaling", () => {
		const guard = resolveOverthinkGuardForModel(createModel("anthropic", false), "off", baseSettings);
		expect(guard.enabled).toBe(false);
		expect(guard.tokenThreshold).toBe(0);
	});

	it("never disables the guard purely from thinking-level scaling", () => {
		const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
		for (const level of levels) {
			const strong = resolveOverthinkGuardForModel(createModel("anthropic", true), level, baseSettings);
			expect(strong.enabled).toBe(true);
			const weak = resolveOverthinkGuardForModel(createModel("opencode", true), level, baseSettings);
			expect(weak.enabled).toBe(true);
		}
	});
});
