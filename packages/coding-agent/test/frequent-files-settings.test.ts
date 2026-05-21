import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager.getFrequentFilesSettings", () => {
	it("returns enabled defaults", () => {
		const sm = SettingsManager.inMemory();
		const cfg = sm.getFrequentFilesSettings();
		// Default ON: anchors the model to recently-touched files. Opt out with
		// `frequentFiles.enabled: false`.
		expect(cfg.enabled).toBe(true);
		expect(cfg.topN).toBe(10);
		expect(cfg.minHits).toBe(2);
		expect(cfg.maxFiles).toBe(256);
	});

	it("honors explicit opt-out", () => {
		const sm = SettingsManager.inMemory({
			frequentFiles: { enabled: false },
		});
		expect(sm.getFrequentFilesSettings().enabled).toBe(false);
	});

	it("honors opt-in with overrides", () => {
		const sm = SettingsManager.inMemory({
			frequentFiles: { enabled: true, topN: 5, minHits: 3, maxFiles: 1024 },
		});
		expect(sm.getFrequentFilesSettings()).toEqual({
			enabled: true,
			topN: 5,
			minHits: 3,
			maxFiles: 1024,
		});
	});

	it("clamps invalid topN/maxFiles (<=0) to defaults", () => {
		const sm = SettingsManager.inMemory({
			frequentFiles: { enabled: true, topN: 0, maxFiles: -50 },
		});
		const cfg = sm.getFrequentFilesSettings();
		expect(cfg.topN).toBe(10);
		expect(cfg.maxFiles).toBe(256);
	});

	it("accepts minHits=0 (no floor)", () => {
		const sm = SettingsManager.inMemory({
			frequentFiles: { enabled: true, minHits: 0 },
		});
		expect(sm.getFrequentFilesSettings().minHits).toBe(0);
	});

	it("rejects NaN values", () => {
		const sm = SettingsManager.inMemory({
			frequentFiles: { enabled: true, topN: Number.NaN, minHits: Number.NaN, maxFiles: Number.NaN },
		});
		const cfg = sm.getFrequentFilesSettings();
		expect(cfg.topN).toBe(10);
		expect(cfg.minHits).toBe(2);
		expect(cfg.maxFiles).toBe(256);
	});

	it("treats undefined enabled as default (enabled)", () => {
		const sm = SettingsManager.inMemory({
			frequentFiles: { enabled: undefined as unknown as boolean, topN: 5 },
		});
		expect(sm.getFrequentFilesSettings().enabled).toBe(true);
	});
});
