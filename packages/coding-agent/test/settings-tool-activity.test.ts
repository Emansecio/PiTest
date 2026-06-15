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

	test("falls back to grouped on an invalid value", () => {
		const sm = SettingsManager.inMemory({ toolActivity: "bogus" as never });
		expect(sm.getToolActivity()).toBe("grouped");
	});
});

describe("getDoubleEscapeAction", () => {
	test("defaults to tree", () => {
		expect(SettingsManager.inMemory().getDoubleEscapeAction()).toBe("tree");
	});

	test("honors a valid override", () => {
		expect(SettingsManager.inMemory({ doubleEscapeAction: "fork" }).getDoubleEscapeAction()).toBe("fork");
	});

	test("falls back to tree on an invalid value", () => {
		const sm = SettingsManager.inMemory({ doubleEscapeAction: "bogus" as never });
		expect(sm.getDoubleEscapeAction()).toBe("tree");
	});
});

describe("getImageWidthCells", () => {
	test("defaults to 60", () => {
		expect(SettingsManager.inMemory().getImageWidthCells()).toBe(60);
	});

	test("clamps to a max of 400", () => {
		const sm = SettingsManager.inMemory({ terminal: { imageWidthCells: 10000 } });
		expect(sm.getImageWidthCells()).toBe(400);
	});

	test("setter clamps to [1, 400]", () => {
		const sm = SettingsManager.inMemory();
		sm.setImageWidthCells(10000);
		expect(sm.getImageWidthCells()).toBe(400);
	});
});

describe("getGoalMaxAutoIterations", () => {
	test("defaults to 50", () => {
		expect(SettingsManager.inMemory().getGoalMaxAutoIterations()).toBe(50);
	});

	test("honors a positive override", () => {
		expect(SettingsManager.inMemory({ goal: { maxAutoIterations: 120 } }).getGoalMaxAutoIterations()).toBe(120);
	});

	test("falls back to 50 on a non-positive value", () => {
		expect(SettingsManager.inMemory({ goal: { maxAutoIterations: 0 } }).getGoalMaxAutoIterations()).toBe(50);
	});
});

describe("getBranchSummarySkipPrompt", () => {
	test("delegates to getBranchSummarySettings().skipPrompt", () => {
		const sm = SettingsManager.inMemory({ branchSummary: { skipPrompt: true } });
		expect(sm.getBranchSummarySkipPrompt()).toBe(sm.getBranchSummarySettings().skipPrompt);
		expect(sm.getBranchSummarySkipPrompt()).toBe(true);
	});
});
