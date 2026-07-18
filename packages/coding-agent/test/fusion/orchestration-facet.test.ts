import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { PermissionChecker } from "../../src/core/permissions/index.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";

const model = getModel("anthropic", "claude-sonnet-5")!;

function createSession(sessionManager = SessionManager.inMemory(), permissionChecker?: PermissionChecker) {
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
		permissionChecker,
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

	it("restoring orchestration=fusion forces the permission mode to plan (no Fusion·Auto on resume)", () => {
		// The permission mode is not persisted, so on resume it falls back to the
		// default (auto). Restoring a fusion orchestration must reconcile the checker
		// down to plan — otherwise resume revives the unreachable Fusion·Auto state.
		const sessionManager = SessionManager.inMemory();
		const first = createSession(
			sessionManager,
			new PermissionChecker({ cwd: process.cwd(), mode: "auto", settings: {} }),
		);
		try {
			first.setOrchestration("fusion");
		} finally {
			first.dispose();
		}

		const resumedChecker = new PermissionChecker({ cwd: process.cwd(), mode: "auto", settings: {} });
		const resumed = createSession(sessionManager, resumedChecker);
		try {
			expect(resumed.orchestration).toBe("fusion");
			expect(resumedChecker.mode).toBe("plan");
		} finally {
			resumed.dispose();
		}
	});

	it("restoring orchestration=solo leaves the permission mode untouched", () => {
		const sessionManager = SessionManager.inMemory();
		const first = createSession(
			sessionManager,
			new PermissionChecker({ cwd: process.cwd(), mode: "auto", settings: {} }),
		);
		try {
			first.setOrchestration("fusion");
			first.setOrchestration("solo");
		} finally {
			first.dispose();
		}

		const resumedChecker = new PermissionChecker({ cwd: process.cwd(), mode: "auto", settings: {} });
		const resumed = createSession(sessionManager, resumedChecker);
		try {
			expect(resumed.orchestration).toBe("solo");
			expect(resumedChecker.mode).toBe("auto");
		} finally {
			resumed.dispose();
		}
	});
});
