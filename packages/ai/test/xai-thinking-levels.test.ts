import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/models.js";
import { XAI_OAUTH_MODELS } from "../src/utils/oauth/xai.js";

describe("xAI Grok thinking levels", () => {
	it("exposes low/medium/high for grok-4.5 (not only high)", () => {
		const model = getModel("xai", "grok-4.5");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high"]);
	});

	it("exposes low/medium/high for grok-build-0.1", () => {
		const model = getModel("xai", "grok-build-0.1");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high"]);
	});

	it("keeps OAuth catalog maps aligned with generated models", () => {
		const oauth = XAI_OAUTH_MODELS.find((m) => m.id === "grok-4.5");
		expect(oauth).toBeDefined();
		expect(getSupportedThinkingLevels(oauth!)).toEqual(["low", "medium", "high"]);
	});

	it("forces reasoning dial on Composer 2.5 (low/medium/high)", () => {
		const model = getModel("xai", "grok-composer-2.5-fast");
		expect(model).toBeDefined();
		expect(model!.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(model!)).toEqual(["low", "medium", "high"]);

		const oauth = XAI_OAUTH_MODELS.find((m) => m.id === "grok-composer-2.5-fast");
		expect(oauth?.reasoning).toBe(true);
		expect(getSupportedThinkingLevels(oauth!)).toEqual(["low", "medium", "high"]);
	});
});
