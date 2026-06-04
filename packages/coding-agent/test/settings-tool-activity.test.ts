import { describe, expect, test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("getToolActivity", () => {
	test("defaults to grouped", () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getToolActivity()).toBe("grouped");
	});

	test("honors an explicit legacy override", () => {
		const sm = SettingsManager.inMemory({ toolActivity: "legacy" });
		expect(sm.getToolActivity()).toBe("legacy");
	});
});
