import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";
import { openrouterModel } from "./helpers/pruned-fixtures.js";

describe("getSupportedThinkingLevels", () => {
	it("includes xhigh for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-6");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it("includes xhigh for Anthropic Opus 4.7 on anthropic-messages API", () => {
		const model = getModel("anthropic", "claude-opus-4-7");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it("does not include xhigh for non-Opus Anthropic models", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it.each(["gpt-5.4", "gpt-5.5"] as const)("includes xhigh for %s models", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});

	it.each(["gpt-5.6-sol", "gpt-5.6-terra"] as const)("includes max and ultra for %s", (modelId) => {
		const model = getModel("openai-codex", modelId);
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
		expect(levels).toContain("ultra");
		// opt-in max/ultra sit at the top of the effort ladder
		expect(levels.at(-1)).toBe("ultra");
		expect(levels.at(-2)).toBe("max");
	});

	it("includes max but not ultra for gpt-5.6-luna", () => {
		const model = getModel("openai-codex", "gpt-5.6-luna");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).toContain("xhigh");
		expect(levels).toContain("max");
		expect(levels).not.toContain("ultra");
		expect(levels.at(-1)).toBe("max");
	});

	it("does not expose max/ultra on older codex models", () => {
		const model = getModel("openai-codex", "gpt-5.5");
		expect(model).toBeDefined();
		const levels = getSupportedThinkingLevels(model!);
		expect(levels).not.toContain("max");
		expect(levels).not.toContain("ultra");
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on opencode-go", () => {
		const model = getModel("opencode-go", "deepseek-v4-flash");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on OpenRouter", () => {
		const model = openrouterModel("deepseek/deepseek-v4-flash", {
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
		});
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes xhigh for OpenRouter Opus 4.6 (openai-completions API)", () => {
		const model = openrouterModel("anthropic/claude-opus-4.6", {
			thinkingLevelMap: { xhigh: "max" },
		});
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
	});
});
