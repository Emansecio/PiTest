import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { createTestResourceLoader } from "./utilities.js";

const model = getModel("anthropic", "claude-sonnet-5")!;

function createSession(): AgentSession {
	const settingsManager = SettingsManager.inMemory();
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

describe("AgentSession.getCachePrefixDiagnostics", () => {
	it("returns a well-formed diagnostic", () => {
		const session = createSession();
		try {
			const diag = session.getCachePrefixDiagnostics();
			expect(typeof diag.rebuilds).toBe("number");
			expect(diag.rebuilds).toBeGreaterThanOrEqual(0);
			expect(Array.isArray(diag.reasons)).toBe(true);
		} finally {
			session.dispose();
		}
	});

	it("does not count a rebuild that leaves the cacheable prefix unchanged", () => {
		const session = createSession();
		try {
			const names = session.getActiveToolNames();
			session.setActiveToolsByName([...names]);
			const a = session.getCachePrefixDiagnostics().rebuilds;
			session.setActiveToolsByName([...names]);
			const b = session.getCachePrefixDiagnostics().rebuilds;
			// Identical tool set → identical prefix → the rebuild is not a rewrite.
			expect(b).toBe(a);
		} finally {
			session.dispose();
		}
	});

	it("counts a tool-surface change that rewrites the prefix, attributed by reason", () => {
		const session = createSession();
		try {
			// Establish a known, rich surface, then strip it down. With fewer tools
			// the textual tool list and tool-derived guidelines (e.g. the
			// verify-after-change nudge, which needs edit/write + bash) shrink, so
			// the cacheable prefix genuinely changes and is counted once.
			session.setActiveToolsByName(["read", "bash", "edit", "write"]);
			const before = session.getCachePrefixDiagnostics().rebuilds;

			session.setActiveToolsByName(["read"]);
			const after = session.getCachePrefixDiagnostics();

			expect(after.rebuilds).toBeGreaterThan(before);
			expect(after.reasons.map((r) => r.reason)).toContain("tool-surface");
		} finally {
			session.dispose();
		}
	});
});
