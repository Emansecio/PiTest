import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { getEngineeringStyleGuidelines, getEngineeringStylePromptGuidelines } from "../src/core/engineering-styles.js";
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
	it("includes the compact karpathy pointer by default", async () => {
		const session = createSession(SettingsManager.inMemory());
		try {
			for (const b of getEngineeringStylePromptGuidelines("karpathy")) {
				expect(session.systemPrompt).toContain(b);
			}
			for (const b of getEngineeringStyleGuidelines("karpathy")) {
				expect(session.systemPrompt).not.toContain(b);
			}
		} finally {
			await session.dispose();
		}
	});

	it('omits karpathy bullets when engineeringStyle is explicitly "default"', async () => {
		const session = createSession(SettingsManager.inMemory({ engineeringStyle: "default" }));
		try {
			for (const b of getEngineeringStyleGuidelines("karpathy")) {
				expect(session.systemPrompt).not.toContain(b);
			}
		} finally {
			await session.dispose();
		}
	});

	it("does not repeat tool-local guidance in the global system prompt", async () => {
		const session = createSession(SettingsManager.inMemory());
		try {
			expect(session.systemPrompt).not.toContain("Use read to examine files instead of cat or sed.");
			expect(session.systemPrompt).not.toContain("Call only when the active tool list lacks a needed capability");
		} finally {
			await session.dispose();
		}
	});
});
