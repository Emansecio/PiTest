import { existsSync, mkdirSync, rmSync } from "fs";
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
		expect(f.timeoutMs).toBe(180_000);
		expect(f.staggerSameCliMs).toBe(400);
		expect(f.showSynthesis).toBe(false);
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
});
