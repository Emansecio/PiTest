import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { getEngineeringStyleGuidelines } from "../src/core/engineering-styles.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-5")!;

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

describe("AgentSession threads engineeringStyle through to the system prompt", () => {
	it("includes karpathy bullets by default (karpathy is the default style)", () => {
		const session = createSession(SettingsManager.inMemory());
		try {
			for (const b of getEngineeringStyleGuidelines("karpathy")) {
				expect(session.systemPrompt).toContain(b);
			}
		} finally {
			session.dispose();
		}
	});

	it('omits karpathy bullets when engineeringStyle is explicitly "default"', () => {
		const session = createSession(SettingsManager.inMemory({ engineeringStyle: "default" }));
		try {
			for (const b of getEngineeringStyleGuidelines("karpathy")) {
				expect(session.systemPrompt).not.toContain(b);
			}
		} finally {
			session.dispose();
		}
	});
});
