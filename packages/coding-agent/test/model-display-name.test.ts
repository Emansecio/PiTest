import { describe, expect, it } from "vitest";
import { formatModelDisplayName } from "../src/modes/interactive/model-display-name.js";

describe("formatModelDisplayName", () => {
	it.each([
		["claude-opus-4-8", "Opus 4.8"],
		["claude-sonnet-4-6", "Sonnet 4.6"],
		["anthropic/claude-haiku-3-5", "Haiku 3.5"],
		["gpt-5.5-codex", "GPT-5.5 Codex"],
		["openai/gpt-5.2-codex-mini", "GPT-5.2 Codex Mini"],
	])("formats %s as %s", (modelId, expected) => {
		expect(formatModelDisplayName(modelId)).toBe(expected);
	});

	it("keeps an unknown model id intact after removing a provider path", () => {
		expect(formatModelDisplayName("custom/vendor-model-v2")).toBe("vendor-model-v2");
	});
});
