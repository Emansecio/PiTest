import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-5")!;

/** Empty temp cwd so boot does not hydrate <repo>/.pit/frequent-files.json. */
function createSession(settingsManager: SettingsManager) {
	const cwd = mkdtempSync(join(tmpdir(), "pit-freq-session-"));
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model,
				systemPrompt: "You are a helpful assistant.",
				tools: [],
				thinkingLevel: "high",
			},
		}),
		sessionManager,
		settingsManager,
		cwd,
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
	return { session, cwd };
}

describe("AgentSession frequent files API", () => {
	const dirs: string[] = [];

	afterEach(() => {
		while (dirs.length > 0) {
			const dir = dirs.pop();
			if (!dir) continue;
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows may keep a handle briefly after dispose; ignore cleanup races.
			}
		}
	});

	it("exposes an empty top-files list on a fresh session", () => {
		const { session, cwd } = createSession(SettingsManager.inMemory());
		dirs.push(cwd);
		try {
			expect(session.getFrequentFiles({ minHits: 0 })).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	it("omits the frequent_files section when disabled", () => {
		const { session, cwd } = createSession(SettingsManager.inMemory());
		dirs.push(cwd);
		try {
			expect(session.systemPrompt).not.toContain("<frequent_files>");
		} finally {
			session.dispose();
		}
	});

	it("omits the frequent_files section when enabled but tracker is empty", () => {
		const { session, cwd } = createSession(
			SettingsManager.inMemory({ frequentFiles: { enabled: true, minHits: 0 } }),
		);
		dirs.push(cwd);
		try {
			// No tool events have fired; section should not appear because no entries exist.
			expect(session.systemPrompt).not.toContain("<frequent_files>");
		} finally {
			session.dispose();
		}
	});
});
