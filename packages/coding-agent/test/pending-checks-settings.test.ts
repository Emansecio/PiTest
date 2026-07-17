import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("getPendingChecksSettings", () => {
	it("defaults enabled with 15min wait and 2 fix attempts", () => {
		const sm = SettingsManager.inMemory();
		expect(sm.getPendingChecksSettings()).toEqual({
			enabled: true,
			maxWaitMs: 900_000,
			maxFixAttempts: 2,
			pollIntervalMs: 500,
		});
	});

	it("respects overrides", () => {
		const sm = SettingsManager.inMemory({
			pendingChecks: { enabled: false, maxWaitMs: 60_000, maxFixAttempts: 1 },
		});
		expect(sm.getPendingChecksSettings()).toEqual({
			enabled: false,
			maxWaitMs: 60_000,
			maxFixAttempts: 1,
			pollIntervalMs: 500,
		});
	});
});
