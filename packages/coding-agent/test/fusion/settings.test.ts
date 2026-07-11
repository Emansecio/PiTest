import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../../src/core/settings-manager.js";

describe("fusion settings", () => {
	const testDir = join(process.cwd(), "test-fusion-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pit"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	it("returns defaults when no fusion section is present", () => {
		const sm = SettingsManager.create(projectDir, agentDir);
		const f = sm.getFusionSettings();
		expect(f.panel).toEqual([]);
		expect(f.timeoutMs).toBe(600_000);
		expect(f.idleTimeoutMs).toBe(90_000);
		expect(f.staggerSameCliMs).toBe(400);
		expect(f.showSynthesis).toBe(false);
		expect(f.lean).toBe(true);
		expect(f.brief).toBe(true);
		expect(f.verify).toBe(true);
		expect(f.verifyTimeoutMs).toBe(60_000);
	});

	it("respects a custom idleTimeoutMs and verify: false", () => {
		writeFileSync(
			join(projectDir, ".pit", "settings.json"),
			JSON.stringify({ fusion: { idleTimeoutMs: 30_000, verify: false } }, null, 2),
			"utf-8",
		);
		const sm = SettingsManager.create(projectDir, agentDir);
		const f = sm.getFusionSettings();
		expect(f.idleTimeoutMs).toBe(30_000);
		expect(f.verify).toBe(false);
	});

	it("respects brief: false when present in fusion settings", () => {
		writeFileSync(
			join(projectDir, ".pit", "settings.json"),
			JSON.stringify({ fusion: { brief: false } }, null, 2),
			"utf-8",
		);
		const sm = SettingsManager.create(projectDir, agentDir);
		const f = sm.getFusionSettings();
		expect(f.brief).toBe(false);
	});

	it("round-trips a panel via setFusionPanel and caps at 2", () => {
		const sm = SettingsManager.create(projectDir, agentDir);
		sm.setFusionPanel([
			{ cli: "claude", model: "opus" },
			{ cli: "codex", model: "gpt-5.5-codex" },
			{ cli: "claude", model: "sonnet" },
		]);
		const f = sm.getFusionSettings();
		expect(f.panel).toHaveLength(2);
		expect(f.panel[0]).toEqual({ cli: "claude", model: "opus" });
	});

	it("patches verify/brief via setFusionFlags without clearing the panel", () => {
		const sm = SettingsManager.create(projectDir, agentDir);
		sm.setFusionPanel([
			{ cli: "claude", model: "opus" },
			{ cli: "codex", model: "gpt-4o" },
		]);
		sm.setFusionFlags({ verify: false, brief: false });
		const f = sm.getFusionSettings();
		expect(f.panel).toHaveLength(2);
		expect(f.verify).toBe(false);
		expect(f.brief).toBe(false);
	});
});
