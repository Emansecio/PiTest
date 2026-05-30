import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createSession(settingsManager: SettingsManager) {
	const sessionManager = SessionManager.inMemory();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	return new AgentSession({
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
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("AgentSession frequent files API", () => {
	it("exposes an empty top-files list on a fresh session", () => {
		const session = createSession(SettingsManager.inMemory());
		try {
			expect(session.getFrequentFiles({ minHits: 0 })).toEqual([]);
		} finally {
			session.dispose();
		}
	});

	it("omits the frequent_files section when disabled", () => {
		const session = createSession(SettingsManager.inMemory());
		try {
			expect(session.systemPrompt).not.toContain("<frequent_files>");
		} finally {
			session.dispose();
		}
	});

	it("omits the frequent_files section when enabled but tracker is empty", () => {
		const session = createSession(SettingsManager.inMemory({ frequentFiles: { enabled: true, minHits: 0 } }));
		try {
			// No tool events have fired; section should not appear because no entries exist.
			expect(session.systemPrompt).not.toContain("<frequent_files>");
		} finally {
			session.dispose();
		}
	});
});
