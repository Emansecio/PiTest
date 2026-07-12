import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
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

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-8", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-8", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings when file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
		});
	});

	describe("applyOverrides precedence", () => {
		it("should preserve overrides across a subsequent save() (triggered by any setter)", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			// Programmatic override (SDK use): disable compaction, custom retry.
			manager.applyOverrides({
				compaction: { enabled: false },
				retry: { enabled: true, maxRetries: 9, baseDelayMs: 1 },
			});
			expect(manager.getCompactionEnabled()).toBe(false);
			expect(manager.getRetrySettings().maxRetries).toBe(9);

			// Any setter calls save(), which recomputes this.settings. Without the
			// sessionOverrides layer the override above is silently discarded here.
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			expect(manager.getCompactionEnabled()).toBe(false);
			expect(manager.getRetrySettings().maxRetries).toBe(9);
			expect(manager.getDefaultThinkingLevel()).toBe("high");

			// Overrides are session-only: never persisted to disk.
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.compaction).toBeUndefined();
			expect(savedSettings.retry).toBeUndefined();
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});

		it("should preserve overrides across reload()", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark", compaction: { enabled: true } }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.applyOverrides({ compaction: { enabled: false } });
			expect(manager.getCompactionEnabled()).toBe(false);

			// External edit + reload recomputes from disk; override must still win.
			writeFileSync(settingsPath, JSON.stringify({ theme: "light", compaction: { enabled: true } }));
			await manager.reload();

			expect(manager.getCompactionEnabled()).toBe(false);
			// Non-overridden fields still reflect the reloaded on-disk values.
			expect(manager.getTheme()).toBe("light");
		});

		it("should keep override precedence over a project-settings save", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.applyOverrides({ retry: { enabled: false } });
			expect(manager.getRetryEnabled()).toBe(false);

			// saveProjectSettings() recomputes this.settings; override must survive.
			manager.setProjectExtensionPaths(["/proj/ext.ts"]);
			await manager.flush();

			expect(manager.getRetryEnabled()).toBe(false);
			expect(manager.getExtensionPaths()).toEqual(["/proj/ext.ts"]);
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".pit", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors.map((e) => e.scope).sort()).toEqual(["global", "project"]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .pit folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .pit folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pit folder that beforeEach created
			rmSync(join(projectDir, ".pit"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .pit folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".pit"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .pit folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .pit folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pit folder that beforeEach created
			rmSync(join(projectDir, ".pit"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .pit folder should NOT exist yet
			expect(existsSync(join(projectDir, ".pit"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .pit folder should exist
			expect(existsSync(join(projectDir, ".pit"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".pit", "settings.json"))).toBe(true);
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(join(projectDir, ".pit", "settings.json"), JSON.stringify({ sessionDir: "./sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("getCompactionSettings selfCorrection wiring", () => {
		// Regression: getCompactionSettings() previously dropped selfCorrection, so the
		// compaction.selfCorrection knob in settings.json was a silent no-op (the extra
		// verification LLM pass always ran). These lock the field through the getter.
		it("should default selfCorrection to true when unset", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getCompactionSettings().selfCorrection).toBe(true);
		});

		it("should read selfCorrection: false from settings.json", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { selfCorrection: false } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getCompactionSettings().selfCorrection).toBe(false);
		});

		it("should let project settings override global selfCorrection", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { selfCorrection: true } }));
			writeFileSync(
				join(projectDir, ".pit", "settings.json"),
				JSON.stringify({ compaction: { selfCorrection: false } }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getCompactionSettings().selfCorrection).toBe(false);
		});
	});

	describe("getGrepSettings", () => {
		const savedEnv = process.env.PIT_GREP_ENGINE;
		afterEach(() => {
			if (savedEnv === undefined) delete process.env.PIT_GREP_ENGINE;
			else process.env.PIT_GREP_ENGINE = savedEnv;
		});

		it("defaults to fff (native, with rg fallback at runtime)", () => {
			delete process.env.PIT_GREP_ENGINE;
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getGrepSettings().engine).toBe("fff");
		});

		it("honors grep.engine: rg opt-out from settings.json", () => {
			delete process.env.PIT_GREP_ENGINE;
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ grep: { engine: "rg" } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getGrepSettings().engine).toBe("rg");
		});

		it("lets PIT_GREP_ENGINE env override settings.json", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ grep: { engine: "rg" } }));
			process.env.PIT_GREP_ENGINE = "fff";
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getGrepSettings().engine).toBe("fff");
		});
	});

	describe("getAstGrepSettings", () => {
		const savedEnv = process.env.PIT_ASTGREP_ENGINE;
		afterEach(() => {
			if (savedEnv === undefined) delete process.env.PIT_ASTGREP_ENGINE;
			else process.env.PIT_ASTGREP_ENGINE = savedEnv;
		});

		it("defaults to napi (in-process, with CLI fallback at runtime)", () => {
			delete process.env.PIT_ASTGREP_ENGINE;
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getAstGrepSettings().engine).toBe("napi");
		});

		it("honors astGrep.engine: cli opt-out from settings.json", () => {
			delete process.env.PIT_ASTGREP_ENGINE;
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ astGrep: { engine: "cli" } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getAstGrepSettings().engine).toBe("cli");
		});

		it("lets PIT_ASTGREP_ENGINE env override settings.json", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ astGrep: { engine: "cli" } }));
			process.env.PIT_ASTGREP_ENGINE = "napi";
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getAstGrepSettings().engine).toBe("napi");
		});
	});
});
