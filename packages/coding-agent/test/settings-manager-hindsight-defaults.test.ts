/**
 * M24 — hindsight hygiene defaults.
 * Verifies that getHindsightSettings() returns the built-in defaults when the
 * user has not configured maxEntries / pruneOlderThanDays, and that explicit
 * user values are honoured without being overridden.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("getHindsightSettings — M24 hygiene defaults", () => {
	const testDir = join(process.cwd(), "test-hindsight-defaults-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pit"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("returns maxEntries=500 when not configured", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		const s = manager.getHindsightSettings();
		expect(s.maxEntries).toBe(500);
	});

	it("returns pruneOlderThanDays=90 when not configured", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		const s = manager.getHindsightSettings();
		expect(s.pruneOlderThanDays).toBe(90);
	});

	it("honours explicit maxEntries set by the user", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hindsight: { maxEntries: 1000 } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		const s = manager.getHindsightSettings();
		expect(s.maxEntries).toBe(1000);
	});

	it("honours explicit pruneOlderThanDays set by the user", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hindsight: { pruneOlderThanDays: 30 } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		const s = manager.getHindsightSettings();
		expect(s.pruneOlderThanDays).toBe(30);
	});

	it("ignores invalid (non-positive) maxEntries and falls back to default", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hindsight: { maxEntries: -5 } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		const s = manager.getHindsightSettings();
		expect(s.maxEntries).toBe(500);
	});

	it("ignores invalid (zero) pruneOlderThanDays and falls back to default", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hindsight: { pruneOlderThanDays: 0 } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		const s = manager.getHindsightSettings();
		expect(s.pruneOlderThanDays).toBe(90);
	});

	it("does not override an explicit maxEntries with the default", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hindsight: { maxEntries: 200 } }));
		const manager = SettingsManager.create(projectDir, agentDir);
		const s = manager.getHindsightSettings();
		expect(s.maxEntries).toBe(200);
		expect(s.maxEntries).not.toBe(500);
	});
});
