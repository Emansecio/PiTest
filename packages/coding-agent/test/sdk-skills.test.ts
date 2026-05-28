import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import type { ResourceLoader } from "../src/core/resource-loader.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { createSyntheticSourceInfo } from "../src/core/source-info.js";

describe("createAgentSession skills option", () => {
	let tempDir: string;
	let skillsDir: string;
	const sessionsToDispose: Array<{ dispose: () => Promise<void> }> = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		skillsDir = join(tempDir, "skills", "test-skill");
		mkdirSync(skillsDir, { recursive: true });

		// Create a test skill in the pi skills directory
		writeFileSync(
			join(skillsDir, "SKILL.md"),
			`---
name: test-skill
description: A test skill for SDK tests.
---

# Test Skill

This is a test skill.
`,
		);
	});

	afterEach(async () => {
		// Dispose any sessions opened during the test so their background workers
		// (frequent-files git child, etc.) drop the cwd handle before rmSync.
		while (sessionsToDispose.length > 0) {
			try {
				await sessionsToDispose.pop()?.dispose();
			} catch {
				// ignore
			}
		}
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				// Best-effort: slow Windows handle release can still race; the OS
				// will reclaim the temp dir eventually.
			}
		}
	});

	it("should discover skills by default and expose them on session.skills", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
		});
		sessionsToDispose.push(session);

		// Skills should be discovered and exposed on the session
		expect(session.resourceLoader.getSkills().skills.length).toBeGreaterThan(0);
		expect(session.resourceLoader.getSkills().skills.some((s) => s.name === "test-skill")).toBe(true);
	});

	it("should have empty skills when resource loader returns none (--no-skills)", async () => {
		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [], diagnostics: [] }),
			getSkillByName: () => undefined,
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getMemoryFiles: () => [],
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		sessionsToDispose.push(session);

		expect(session.resourceLoader.getSkills().skills).toEqual([]);
		expect(session.resourceLoader.getSkills().diagnostics).toEqual([]);
	});

	it("should use provided skills when resource loader supplies them", async () => {
		const customSkill = {
			name: "custom-skill",
			description: "A custom skill",
			filePath: "/fake/path/SKILL.md",
			baseDir: "/fake/path",
			sourceInfo: createSyntheticSourceInfo("/fake/path/SKILL.md", { source: "sdk" }),
			disableModelInvocation: false,
		};

		const resourceLoader: ResourceLoader = {
			getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
			getSkills: () => ({ skills: [customSkill], diagnostics: [] }),
			getSkillByName: (name: string) => (name === customSkill.name ? customSkill : undefined),
			getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }),
			getAgentsFiles: () => ({ agentsFiles: [] }),
			getMemoryFiles: () => [],
			getSystemPrompt: () => undefined,
			getAppendSystemPrompt: () => [],
			extendResources: () => {},
			reload: async () => {},
		};

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(),
			resourceLoader,
		});
		sessionsToDispose.push(session);

		expect(session.resourceLoader.getSkills().skills).toEqual([customSkill]);
		expect(session.resourceLoader.getSkills().diagnostics).toEqual([]);
	});
});
