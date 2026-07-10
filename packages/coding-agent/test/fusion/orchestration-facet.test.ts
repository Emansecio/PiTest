import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createSession(sessionManager = SessionManager.inMemory()) {
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
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

describe("orchestration facet", () => {
	it("defaults to solo and toggles to fusion", () => {
		const session = createSession();
		try {
			expect(session.orchestration).toBe("solo");
			session.setOrchestration("fusion");
			expect(session.orchestration).toBe("fusion");
		} finally {
			session.dispose();
		}
	});

	it("persists orchestration and restores it on a new session over the same journal", () => {
		const sessionManager = SessionManager.inMemory();
		const session = createSession(sessionManager);
		try {
			session.setOrchestration("fusion");
			const entries = sessionManager.getEntries();
			const orch = entries.filter(
				(e) => e.type === "custom" && (e as { customType?: string }).customType === "orchestration",
			);
			expect(orch.length).toBeGreaterThan(0);
			expect((orch[orch.length - 1] as { data?: { orchestration?: string } }).data?.orchestration).toBe("fusion");
		} finally {
			session.dispose();
		}

		const resumed = createSession(sessionManager);
		try {
			expect(resumed.orchestration).toBe("fusion");
		} finally {
			resumed.dispose();
		}
	});

	it("stays solo when the journal has no orchestration entry", () => {
		const session = createSession();
		try {
			expect(session.orchestration).toBe("solo");
		} finally {
			session.dispose();
		}
	});
});
