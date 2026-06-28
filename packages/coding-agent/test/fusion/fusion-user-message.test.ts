import { Agent } from "@pit/agent-core";
import { getModel } from "@pit/ai";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/agent-session.js";
import { emitFusionUserMessage, emitSyntheticAssistant } from "../../src/core/agent-session-fusion.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import { ModelRegistry } from "../../src/core/model-registry.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";
import { createTestResourceLoader } from "../utilities.js";

const model = getModel("anthropic", "claude-sonnet-4-5")!;

function createSession() {
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
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		cwd: process.cwd(),
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
}

function messageText(message: unknown): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content.map((c) => (c as { text?: string }).text ?? "").join("");
	}
	return "";
}

describe("Fusion turn persists the user message", () => {
	// Regression for the bug where the Fusion branch returned from _promptOnce before the
	// user message was appended, so the writer's assistant reply landed in history with no
	// preceding user message (malformed transcript → breaks provider alternation on the next
	// turn). The writer callback now calls _emitFusionUserMessage(userPrompt) before streaming
	// the synthesized answer; this exercises that helper + the assistant twin in the same order
	// the writer path uses them.
	it("lands a user message before the synthesized assistant reply, in order", () => {
		const session = createSession();
		try {
			emitFusionUserMessage(session, "explain the auth flow");
			emitSyntheticAssistant(session, "here is the synthesized answer");

			const roles = session.agent.state.messages.map((m) => m.role);
			expect(roles).toEqual(["user", "assistant"]);
			expect(messageText(session.agent.state.messages[0])).toContain("explain the auth flow");
			expect(messageText(session.agent.state.messages[1])).toContain("synthesized answer");
		} finally {
			session.dispose();
		}
	});

	it("does not start history with an assistant message (Anthropic alternation guard)", () => {
		const session = createSession();
		try {
			emitFusionUserMessage(session, "first fusion prompt");
			expect(session.agent.state.messages[0]?.role).toBe("user");
		} finally {
			session.dispose();
		}
	});
});
